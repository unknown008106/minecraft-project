// The crafter on a real server, end to end through chat. Needs a running crew server (server-crew/, RCON on) with
// nobody else on it: it starts the crew itself (Crew1, obeying CrewTester), logs a test player CrewTester in, sets
// each scene up through RCON, types the requests in chat like a player, and checks what lands in the player's bag.
//
//   node bridge/crew/tools/crafter_live.js            every scene
//   node bridge/crew/tools/crafter_live.js demo       one scene (demo, six, iron, notable, far, twice)
//
// The player only does survival things: chats, walks up, drops one cobblestone. RCON only sets the scene (clears,
// gives the starting materials, teleports, places the table) and reads bags at the end.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const mineflayer = require('mineflayer')
const { Rcon } = require('../../rcon')
const CONFIG = require('../crew.config.json')

const ROOT = path.join(__dirname, '..', '..', '..')
const TESTER = 'CrewTester'
const BOT = 'Crew1'
const Y = -60  // standing height on a default flat world (grass at -61)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...a) => console.log(`[live ${new Date().toTimeString().slice(0, 8)}]`, ...a)

function rconSettings () {
  const props = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'server-crew', 'server.properties'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  return { port: parseInt(props['rcon.port'], 10), password: props['rcon.password'] }
}

// Everything the bot says in chat, and a way to wait for a line
class Chat {
  constructor (player) {
    this.lines = []
    this.waiters = []
    player.on('messagestr', text => {
      const m = String(text).match(/^(?:\[[^\]]*\] )*<([^>]+)> (.*)$/)
      if (!m || m[1] !== BOT) return
      this.lines.push(m[2])
      log(`  ${BOT}: ${m[2]}`)
      for (const w of this.waiters.slice()) if (w.re.test(m[2])) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m[2]) }
    })
  }

  mark () { this.from = this.lines.length }
  since () { return this.lines.slice(this.from || 0) }

  wait (re, ms) {
    const seen = this.since().find(l => re.test(l))
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const w = { re, resolve }
      this.waiters.push(w)
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`no "${re}" from ${BOT} within ${ms / 1000} s`)) } }, ms)
    })
  }
}

const bagCount = (player, name) => player.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

// How many of an item a player holds, read on the server (clear with count 0 only counts)
async function serverCount (rcon, who, item) {
  const r = await rcon.send(`clear ${who} ${item} 0`)
  const m = r.match(/Found (\d+)/i)  // "No items were found on player Crew1" is 0 (the 1 is the name)
  return m ? parseInt(m[1], 10) : 0
}

async function scene (rcon, { bot = {}, tester = {}, table = true, testerAt = [4, Y, 0] }) {
  await rcon.send(`fill -8 ${Y} -8 8 ${Y + 4} 8 air`)
  await rcon.send(`kill @e[type=item]`)
  await rcon.send(`clear ${BOT}`)
  await rcon.send(`clear ${TESTER}`)
  await rcon.send(`tp ${BOT} 0.5 ${Y} 0.5`)
  await rcon.send(`tp ${TESTER} ${testerAt[0] + 0.5} ${testerAt[1]} ${testerAt[2] + 0.5}`)
  if (table) await rcon.send(`setblock 0 ${Y} 2 crafting_table`)
  for (const [item, n] of Object.entries(bot)) await rcon.send(`give ${BOT} ${item} ${n}`)
  for (const [item, n] of Object.entries(tester)) await rcon.send(`give ${TESTER} ${item} ${n}`)
  await sleep(1500)
}

const SCENES = {
  // the hackathon demo: 1 oak log + 2 cobblestone by a table, ask for a stone pickaxe, hand over 1 cobblestone
  async demo ({ rcon, player, chat }) {
    await scene(rcon, { bot: { oak_log: 1, cobblestone: 2 }, tester: { cobblestone: 1 } })
    chat.mark()
    player.chat('craft me a stone pickaxe')
    const need = await chat.wait(/need .* more/, 20000)
    if (!/need 1 cobblestone more/.test(need)) throw new Error(`expected exactly 1 cobblestone missing, got "${need}"`)
    // walk up and drop the block in front of the bot, like a player pressing Q
    await rcon.send(`tp ${TESTER} 2.5 ${Y} 0.5`)
    await sleep(500)
    const botEntity = player.players[BOT]?.entity
    if (botEntity) await player.lookAt(botEntity.position.offset(0, 0.5, 0), true)
    await player.toss(player.registry.itemsByName.cobblestone.id, null, 1)
    log('  CrewTester dropped 1 cobblestone, no second command')
    await chat.wait(/Here's your stone pickaxe/, 60000)
    await sleep(1500)
    return { tester: bagCount(player, 'stone_pickaxe'), bot: await serverCount(rcon, BOT, 'stone_pickaxe'), item: 'stone_pickaxe' }
  },

  // all six items from raw materials by a table, each crafted once and handed over
  async six (ctx) {
    const bags = {
      wooden_pickaxe: { oak_log: 2 },
      stone_pickaxe: { oak_log: 1, cobblestone: 3 },
      iron_pickaxe: { oak_log: 1, iron_ingot: 3 },
      diamond_pickaxe: { oak_log: 1, diamond: 3 },
      furnace: { cobblestone: 8 },
      crafting_table: { oak_log: 1 }
    }
    const out = []
    for (const [item, bot] of Object.entries(bags)) {
      out.push(await one(ctx, item, { bot }))
    }
    return out
  },

  // raw iron: no ingots, no furnace near. It crafts and places a furnace, smelts 3 with the coal, crafts, gives
  async iron (ctx) {
    const r = await one(ctx, 'iron_pickaxe', { bot: { raw_iron: 3, coal: 1, cobblestone: 8, oak_log: 1 } }, 120000)
    r.rawIronLeft = await serverCount(ctx.rcon, BOT, 'raw_iron')
    r.ingotsLeft = await serverCount(ctx.rcon, BOT, 'iron_ingot')
    return r
  },

  // no table in reach: it crafts one from the wood it counted, places it, uses it, picks it back up
  async notable (ctx) {
    const r = await one(ctx, 'stone_pickaxe', { bot: { oak_log: 2, cobblestone: 3 }, table: false })
    r.tableBack = await serverCount(ctx.rcon, BOT, 'crafting_table')
    return r
  },

  // the player walks off: it keeps the item and says so, then hands it over when they come back
  async far ({ rcon, player, chat }) {
    await scene(rcon, { bot: { oak_log: 1, cobblestone: 3 } })
    chat.mark()
    player.chat('craft me a stone pickaxe')
    await rcon.send(`tp ${TESTER} 300.5 ${Y} 0.5`)
    await chat.wait(/is ready, I'm keeping it/, 60000)
    await rcon.send(`tp ${TESTER} 5.5 ${Y} 3.5`)
    await chat.wait(/Here's your stone pickaxe/, 60000)
    await sleep(1500)
    return { tester: bagCount(player, 'stone_pickaxe'), bot: await serverCount(rcon, BOT, 'stone_pickaxe'), item: 'stone_pickaxe' }
  },

  // the same request twice while it waits for materials: one job, one pickaxe
  async twice ({ rcon, player, chat }) {
    await scene(rcon, { bot: { oak_log: 1, cobblestone: 2 } })
    chat.mark()
    player.chat('craft me a stone pickaxe')
    await chat.wait(/need 1 cobblestone more/, 20000)
    player.chat('craft me a cobblestone pickaxe')
    await chat.wait(/already on your stone pickaxe/, 10000)
    await rcon.send(`give ${BOT} cobblestone 1`)
    await chat.wait(/Here's your stone pickaxe/, 60000)
    await sleep(3000)
    return { tester: bagCount(player, 'stone_pickaxe'), bot: await serverCount(rcon, BOT, 'stone_pickaxe'), item: 'stone_pickaxe' }
  }
}

async function one ({ rcon, player, chat }, item, opts, ms = 60000) {
  await scene(rcon, opts)
  chat.mark()
  const before = bagCount(player, item)
  player.chat(`craft me a ${item.replace(/_/g, ' ')}`)
  await chat.wait(new RegExp(`Here's your ${item.replace(/_/g, ' ')}`), ms)
  await sleep(1500)
  return { item, tester: bagCount(player, item) - before, bot: await serverCount(rcon, BOT, item) }
}

async function main () {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENES)
  const rc = rconSettings()
  const rcon = new Rcon(CONFIG.host, rc.port, rc.password)
  await rcon.connect()
  await rcon.send('time set day')
  await rcon.send('weather clear')
  await rcon.send('gamerule doDaylightCycle false')

  const crew = spawn(process.execPath, [path.join(__dirname, '..', 'crew.js'), '--names', BOT, '--owner', TESTER, '--no-translator'], { stdio: ['ignore', 'inherit', 'pipe'] })
  let ready
  const readyP = new Promise(resolve => { ready = resolve })
  crew.stderr.on('data', d => {
    const s = String(d)
    process.stderr.write(s.split('\n').filter(Boolean).map(l => `  crew| ${l}`).join('\n') + '\n')
    if (/crew ready/.test(s)) ready()
  })
  await Promise.race([readyP, sleep(30000)])

  const player = mineflayer.createBot({ host: CONFIG.host, port: CONFIG.port, username: TESTER, version: CONFIG.version, auth: 'offline' })
  await new Promise((resolve, reject) => { player.once('spawn', resolve); player.once('error', reject) })
  const chat = new Chat(player)
  await sleep(2000)

  const results = {}
  let failed = 0
  for (const name of pick) {
    log(`scene ${name}`)
    try {
      const r = await SCENES[name]({ rcon, player, chat })
      const list = Array.isArray(r) ? r : [r]
      const ok = list.every(x => x.tester === 1 && x.bot === 0)
      results[name] = { ok, results: list, chat: chat.since() }
      if (!ok) failed++
      log(`scene ${name}: ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(list)}`)
    } catch (err) {
      failed++
      results[name] = { ok: false, error: err.message, chat: chat.since() }
      log(`scene ${name}: FAIL ${err.message}`)
    }
  }
  const out = path.join(ROOT, 'runs', 'crew-tests', 'crafter_live.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  log(`${pick.length - failed}/${pick.length} scenes passed, results in ${path.relative(ROOT, out)}`)
  player.quit()
  crew.kill('SIGINT')
  rcon.close()
  setTimeout(() => process.exit(failed ? 1 : 0), 2000)
}

main().catch(err => { console.error(err); process.exit(1) })
