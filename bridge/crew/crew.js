// The crew: helper bots the owner commands in chat on the crew server (server-crew/, see docs/crew.md).
//
//   node bridge/crew/crew.js                      the bots named in crew.config.json (Crew1, Crew2)
//   node bridge/crew/crew.js --bots 3             Crew1 to Crew3
//   node bridge/crew/crew.js --names Ann,Bob      these names (add them to the crew whitelist first)
//   node bridge/crew/crew.js --run runs/<version> another saved version of the fighting network
//   node bridge/crew/crew.js --owner CrewTester   obey another name (the live test harness, livetest.js)
//   node bridge/crew/crew.js --metrics <file>     append one JSON line per finished job, death and chat event
//   node bridge/crew/crew.js --miner old          the earlier single tunnel miner (for the mining benchmark)
//   node bridge/crew/crew.js --builds <file>      where the crew remembers what it built (default server-crew/crew-builds.json)
//
// Only the owner's chat counts. "!" lines are commands, "@crew ..." or "Crew1 ..." in plain words go through the
// translator. Each bot runs a priority mode manager (behaviors.js) ticked every game tick.

const fs = require('fs')
const path = require('path')
require('../patch-physics')  // the same movement physics the fighter trained with
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { Rcon } = require('../rcon')
const { Vec3 } = require('vec3')
const { parseChatLine, parseMessage, formatCommand, SOLO } = require('./commands')
const { aOrAn } = require('./skills/crafter_plan')
const bp = require('./skills/blueprint')
const { withCrop } = require('./skills/farm')
const { Designer } = require('./designer')
const { Friends, Blackboard, guardAttacks } = require('./targets')
const { makeModes } = require('./behaviors')
const { FightSkill, ensureKit, stopFight } = require('./skills/fight')
const { PolicyClient } = require('./skills/policy')
const { Human } = require('./skills/human')
const { Translator } = require('./translator')

const ROOT = path.join(__dirname, '..', '..')
const CONFIG = require('./crew.config.json')
const JOB_COMMANDS = new Set(['kill', 'mine', 'come', 'give', 'build', 'expand', 'explore', 'design', 'craft'])
// one shot jobs: starting one ends the others (the farm keeps going underneath, follow comes back after)
const ONE_SHOT = ['build', 'mine', 'explore']
const CUSTOM_BLUEPRINTS = path.join(ROOT, 'server-crew', 'blueprints')
const BUILDS_FILE = path.join(ROOT, 'server-crew', 'crew-builds.json')
const RECONNECT_MS = 5000

function stamp () {
  const d = new Date()
  return d.toTimeString().slice(0, 8)
}
const log = (...a) => console.error(`[crew ${stamp()}]`, ...a)

function parseArgs (argv) {
  const opts = { names: CONFIG.bots, run: CONFIG.fighter_run, translator: true, owner: CONFIG.owner, metrics: null, miner: 'new' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bots') opts.names = Array.from({ length: Math.max(1, parseInt(argv[++i], 10) || 2) }, (_, k) => `Crew${k + 1}`)
    else if (a === '--names') opts.names = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--run') opts.run = argv[++i]
    else if (a === '--no-translator') opts.translator = false
    else if (a === '--owner') opts.owner = argv[++i]
    else if (a === '--metrics') opts.metrics = argv[++i]
    else if (a === '--miner') opts.miner = argv[++i] === 'old' ? 'old' : 'new'
    else if (a === '--builds') opts.builds = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 14).join('\n'))
      process.exit(0)
    }
  }
  return opts
}

// What the crew has built, kept next to the world it stands in, so !expand and !farm find their builds again
class Builds {
  constructor (file) {
    this.file = file
    this.items = []
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (!Array.isArray(this.items)) this.items = []
  }

  list () { return this.items }

  // A finished build. The same blueprint on the same anchor (a rebuild or an expansion) updates its record
  add (bot, job) {
    const a = job.anchor
    const box = job.box ? { min: { x: job.box.min.x, y: job.box.min.y, z: job.box.min.z }, max: { x: job.box.max.x, y: job.box.max.y, z: job.box.max.z } } : null
    const fields = {
      blueprint: job.blueprint.name,
      anchor: [a.x, a.y, a.z],
      facing: job.facing,
      modules: job.modules || 1,
      crop: job.crop || (bp.cellsOf(job.blueprint).some(c => bp.CROPS[c.name]) ? 'wheat' : null),
      box,
      bot: bot.username,
      at: new Date().toISOString()
    }
    let rec = this.items.find(r => r.blueprint === fields.blueprint && r.anchor.join() === fields.anchor.join())
    if (rec) Object.assign(rec, fields)
    else {
      rec = { id: `${fields.blueprint}-${Date.now()}`, ...fields }
      this.items.push(rec)
    }
    job.record = rec
    this.save()
    return rec
  }

  // The nearest record of this blueprint (or with this id) to a point
  find (name, point) {
    const list = this.items.filter(r => r.blueprint === name || r.id === name)
    if (!point) return list[list.length - 1] || null
    return list.sort((a, b) => dist(a.anchor, point) - dist(b.anchor, point))[0] || null
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2))
    } catch (err) {
      log(`builds: ${err.message}`)
    }
  }
}
const dist = (a, p) => Math.hypot(a[0] - p.x, a[1] - p.y, a[2] - p.z)

// RCON settings of the crew server, read from its own server.properties
function crewRconSettings () {
  const file = path.join(ROOT, 'server-crew', 'server.properties')
  if (!fs.existsSync(file)) return null
  const props = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  if (props['enable-rcon'] !== 'true') return null
  return { port: parseInt(props['rcon.port'], 10), password: props['rcon.password'] }
}

class Crew {
  constructor (opts) {
    this.opts = opts
    this.owner = opts.owner || CONFIG.owner
    this.names = opts.names
    // the real owner stays a friend while a test owner gives the orders
    this.friends = new Friends(this.owner, this.names, [CONFIG.owner, ...(CONFIG.friends || [])])
    this.metricsFile = opts.metrics || null
    this.miner = opts.miner || 'new'
    this.builds = new Builds(opts.builds || BUILDS_FILE)
    this.designer = new Designer({ log, credentials: opts.translator ? undefined : null })
    this.blackboard = new Blackboard()
    this.ctxs = new Map()  // bot name to its context
    this.policy = new PolicyClient(opts.run, log)
    const blueprints = () => this.blueprintNames().map(n => ({ name: n, description: this.loadBlueprint(n)?.description }))
    this.translator = opts.translator
      ? new Translator({ model: CONFIG.translator_model, botNames: this.names, log, blueprints })
      : new Translator({ botNames: this.names, log, credentials: null, blueprints })
    this.lastAnnounce = { text: '', at: 0 }
    this.verbosity = 'normal'  // quiet, normal or verbose (!quiet, !verbose)
    this.lastEvent = new Map()
    this.rcon = null
    this.closing = false
    this.log = log
  }

  async start () {
    const rc = crewRconSettings()
    if (rc) {
      try {
        const r = new Rcon(CONFIG.host, rc.port, rc.password)
        await r.connect()
        this.rcon = r
      } catch (err) {
        log(`no console access (RCON ${rc.port}): ${err.message}, the fight kit is off`)
      }
    }
    log(this.translator.enabled ? `translator on (${this.translator.model})` : 'translator off: no API key in ~/.config/anthropic/api.env')
    for (const name of this.names) {
      await this.connect(name)
      await new Promise(resolve => setTimeout(resolve, 1500))  // the server refuses quick joins from one address
    }
  }

  connect (name) {
    return new Promise(resolve => {
      const bot = mineflayer.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        username: name,
        version: CONFIG.version,
        auth: 'offline',
        checkTimeoutInterval: 60000
      })
      bot.setMaxListeners(50)
      bot.loadPlugin(pathfinder)
      let spawned = false
      bot.once('spawn', () => {
        spawned = true
        // bridge.js makeBot: since 1.21.9 velocity packets are already in blocks per tick, Mineflayer 4.39 still
        // divides them, so knockback did nothing. Same fix, so the fighter feels the knockback it trained with
        bot._client.on('entity_velocity', p => {
          const e = bot.entities[p.entityId]
          if (e) e.velocity.set(p.velocity.x, p.velocity.y, p.velocity.z)
        })
        this.setupBot(bot)
        log(`${name} joined`)
        resolve(bot)
      })
      let duplicate = false
      bot.on('kicked', reason => {
        const text = JSON.stringify(reason)
        // someone else logged in with this name (another crew process, or a person): rejoining would kick them in
        // turn, and the two would take turns forever
        duplicate = text.includes('duplicate_login')
        log(`${name} was kicked: ${text.slice(0, 200)}`)
      })
      bot.on('error', err => log(`${name}: ${err.message}`))
      bot.on('end', reason => {
        const ctx = this.ctxs.get(name)
        if (ctx && ctx.bot === bot) {
          ctx.alive = false
          ctx.fight?.stop()
        }
        if (!spawned) resolve(null)
        if (this.closing) return
        if (duplicate) {
          log(`${name} is logged in somewhere else, not rejoining`)
          return
        }
        log(`${name} left (${reason}), joining again in ${RECONNECT_MS / 1000} s`)
        setTimeout(() => this.connect(name), RECONNECT_MS)
      })
    })
  }

  setupBot (bot) {
    guardAttacks(bot, this.friends, log)
    const ctx = { bot, crew: this, alive: true, seq: 0, pickaxes: null, lastPos: null }
    bot.trail = []  // the cells of its own tunnel, for backing out of water
    ctx.human = new Human(bot, this.ctxs.get(bot.username)?.human?.level || CONFIG.human || 'light')
    ctx.fight = new FightSkill(bot, this.policy, { friends: this.friends, noDigMoves: this.noDigMoves(bot), log })
    bot.crewFight = ctx.fight
    makeModes(ctx)
    this.ctxs.set(bot.username, ctx)
    bot.on('physicsTick', () => {
      if (!ctx.alive) return
      ctx.manager.tick()
      this.breathe(bot, ctx)
      if (bot.health > 0) ctx.lastPos = bot.entity.position.clone()
      if (++ctx.ticks % 20 === 0) this.watchPickaxes(bot, ctx)
    })
    ctx.ticks = 0
    bot.on('messagestr', text => {
      if (this.listener() !== bot) return
      this.handleChat(bot, text).catch(err => log(`command failed: ${err.stack || err.message}`))
    })
    bot.on('death', () => {
      const p = ctx.lastPos || bot.entity.position
      log(`${bot.username} died at ${p.floored()}`)
      this.metric({ bot: bot.username, death: true, pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], mode: ctx.manager?.status() })
      this.event(bot, 'key', 'died', `I died at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`, 0)
      ctx.pickaxes = null  // everything dropped, so do not report its pickaxe as broken
      bot.trail = []
    })
  }

  // One chat line as the server sends it ("<Live_Fonam> craft me a stone pickaxe"). Only the owner gives orders; a
  // friend may ask the crafter for an item (it hands it to whoever asked), nothing else
  async handleChat (bot, text) {
    const line = parseChatLine(text)
    if (!line || line.sender === bot.username) return
    if (line.sender.toLowerCase() !== this.owner.toLowerCase()) {
      if (!this.friends.has(line.sender) || this.names.some(n => n.toLowerCase() === line.sender.toLowerCase())) return
      const p = parseMessage(line.message, this.names)
      if (p?.type !== 'command' || p.command.name !== 'craft') return
    }
    await this.onOwnerMessage(line.message, line.sender)
  }

  // A pickaxe gone from the bag while the bot lives means it broke (the kit and !give never take pickaxes away)
  watchPickaxes (bot, ctx) {
    if (bot.health <= 0) return
    const n = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe')).length
    if (ctx.pickaxes !== null && n < ctx.pickaxes) {
      this.event(bot, 'key', 'pickaxe', n ? 'One of my pickaxes broke' : 'My pickaxe broke', 0)
    }
    ctx.pickaxes = n
  }

  // News for the owner. level: key (always said), normal (not in quiet), detail (verbose only). The same news from
  // the same bot is said at most once per gap milliseconds
  event (bot, level, key, text, gap = 10000) {
    const shown = { quiet: ['key'], normal: ['key', 'normal'], verbose: ['key', 'normal', 'detail'] }[this.verbosity]
    log(`${bot.username} event: ${text}`)
    this.metric({ bot: bot.username, event: key, level, text })
    if (!shown.includes(level)) return
    const id = `${bot.username}:${key}`
    const now = Date.now()
    if (gap && now - (this.lastEvent.get(id) || 0) < gap) return
    this.lastEvent.set(id, now)
    this.say(bot, text)
  }

  // One JSON line per finished job, death or chat event, for the live test harness and the mining benchmark
  metric (record) {
    if (!this.metricsFile) return
    try {
      fs.appendFileSync(this.metricsFile, JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n')
    } catch (err) {
      log(`metrics: ${err.message}`)
    }
  }

  // Control moved to a mode of another skill profile: put the old profile's work away
  profileChanged (ctx, prev, next) {
    const bot = ctx.bot
    if (prev === 'fight') stopFight(bot)
    if (prev === 'mine') {
      try { bot.stopDigging() } catch {}
    }
    if (prev !== 'idle' || next !== 'idle') log(`${bot.username}: ${prev} to ${next}`)
  }

  // A reflex under every mode: out of air in water, swim up (a bot drowned while mining in the live test)
  breathe (bot, ctx) {
    const low = bot.entity.isInWater && bot.oxygenLevel !== undefined && bot.oxygenLevel < 10
    if (low) {
      bot.setControlState('jump', true)
      ctx.swimming = true
    } else if (ctx.swimming) {
      bot.setControlState('jump', false)
      ctx.swimming = false
    }
  }

  // The one bot that reads chat for everyone, so each line is handled once
  listener () {
    for (const name of this.names) {
      const ctx = this.ctxs.get(name)
      if (ctx?.alive) return ctx.bot
    }
    return null
  }

  digMoves (bot) {
    if (!bot._crewDig) {
      const m = new Movements(bot)
      m.canDig = true
      m.allowParkour = true
      m.liquidCost = 50  // around water, a bot drowned walking to an ore in the live test
      m.maxDropDown = 3  // the default 4 costs half a heart
      bot._crewDig = m
    }
    return bot._crewDig
  }

  noDigMoves (bot) {
    if (!bot._crewNoDig) {
      const m = new Movements(bot)
      m.canDig = false
      m.allow1by1towers = false
      m.scafoldingBlocks = []
      bot._crewNoDig = m
    }
    return bot._crewNoDig
  }

  // Walking around a building site: never digs (his blocks stay where they are), never places stray blocks of its
  // own, opens doors, short drops only
  buildMoves (bot) {
    if (!bot._crewBuild) {
      const m = new Movements(bot)
      m.canDig = false
      m.allow1by1towers = false
      m.scafoldingBlocks = []
      m.allowParkour = false
      m.canOpenDoors = true
      m.maxDropDown = 3
      m.liquidCost = 50
      bot._crewBuild = m
    }
    return bot._crewBuild
  }

  // A blueprint from the library, or one Claude drew for him (server-crew/blueprints)
  loadBlueprint (name) {
    return bp.loadBlueprint(name) || bp.loadBlueprint(name, CUSTOM_BLUEPRINTS)
  }

  blueprintNames () {
    return [...new Set([...bp.listBlueprints(), ...bp.listBlueprints(CUSTOM_BLUEPRINTS)])].sort()
  }

  // The farms it built, newest last
  farms () {
    return this.builds.list().filter(r => r.crop)
  }

  // Where the owner stands: the ground under him (the first full block below his feet, so a jump or a hover does
  // not lift the build into the air) and his look, or null when no bot can see him
  ownerSpot () {
    for (const ctx of this.ctxs.values()) {
      const e = ctx.alive && ctx.bot.players[this.owner]?.entity
      if (e) {
        const f = e.position.floored()
        let ground = f.offset(0, -1, 0)
        for (let i = 0; i < 12; i++) {
          const b = ctx.bot.blockAt(f.offset(0, -1 - i, 0))
          if (!b) break
          if (b.boundingBox === 'block') { ground = b.position; break }
        }
        return { anchor: new Vec3(ground.x, ground.y, ground.z), yaw: e.yaw }
      }
    }
    return null
  }

  say (bot, text) {
    if (!bot) return
    try { bot.chat(String(text).slice(0, 250)) } catch {}
  }

  // A line for the whole crew, said once even when every bot reaches the same conclusion
  announce (text) {
    const now = Date.now()
    if (this.lastAnnounce.text === text && now - this.lastAnnounce.at < 3000) return
    this.lastAnnounce = { text, at: now }
    this.say(this.listener(), text)
  }

  async ensureKit (bot) {
    if (!this.rcon) {
      if (!this.saidNoKit) this.say(bot, 'No console access, I fight with what I carry')
      this.saidNoKit = true
      return
    }
    try {
      await ensureKit(bot, this.rcon, log)
    } catch (err) {
      log(`${bot.username} kit: ${err.message}`)
    }
  }

  stopAll (bot) {
    stopFight(bot)
    try { bot.pathfinder.stop() } catch {}
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    try { bot.stopDigging() } catch {}
    try { bot.deactivateItem() } catch {}
    this.blackboard.clear()
  }

  targetsOf (targets) {
    const names = targets === 'all' ? this.names : targets
    return names.map(n => this.ctxs.get(n)).filter(c => c?.alive)
  }

  // sender: who said it (the owner, or a friend asking the crafter), the crafter hands the item to them
  async onOwnerMessage (message, sender = this.owner) {
    const p = parseMessage(message, this.names)
    if (!p) return
    if (p.type === 'command' && p.command.name === 'craft') p.command.args.requester = sender
    if (p.type === 'error') {
      this.say(this.listener(), p.error)
      return
    }
    if (p.type === 'command') {
      let ctxs = this.targetsOf(p.targets)
      if (!ctxs.length) return
      if (p.command.name === 'quiet' || p.command.name === 'verbose') {
        this.verbosity = this.verbosity === p.command.name ? 'normal' : p.command.name
      }
      this.pinHere(p.command)
      if (SOLO.has(p.command.name) && p.targets === 'all') ctxs = [this.pickSolo(ctxs, p.command)]
      for (const ctx of ctxs) {
        ctx.seq++  // a typed command replaces any plan still queued
        this.execute(ctx, p.command)
      }
      this.acknowledge(ctxs, p.command)
      return
    }
    // plain words through the translator
    const r = await this.translator.translate(p.text, p.targets)
    if (r.error) { this.say(this.listener(), r.error.slice(0, 120)); return }
    if (!r.parsed.length) {
      this.say(this.listener(), r.reject ? `Can't do that: ${String(r.reject).slice(0, 100)}` : 'I did not get a command out of that')
      return
    }
    log(`translated "${p.text}" to ${r.lines.join(' ; ')}`)
    this.say(this.listener(), `On it: ${r.lines.join(', ')}`.slice(0, 250))
    // a stop anywhere in the plan acts at once, the rest runs in order per bot. "here" means where he stood when he
    // said it, and the jobs one bot takes go to the same bot
    const perBot = new Map()
    let solo = null
    for (const { targets, command } of r.parsed) {
      this.pinHere(command)
      if (command.name === 'craft') command.args.requester = sender
      let ctxs = this.targetsOf(targets)
      if (SOLO.has(command.name) && targets === 'all' && ctxs.length) {
        solo = solo || this.pickSolo(ctxs, command)
        ctxs = [solo]
      }
      for (const ctx of ctxs) {
        if (!perBot.has(ctx)) perBot.set(ctx, [])
        perBot.get(ctx).push(command)
      }
    }
    for (const [ctx, commands] of perBot) this.runPlan(ctx, commands)
  }

  async runPlan (ctx, commands) {
    const seq = ++ctx.seq
    for (const command of commands) {
      if (ctx.seq !== seq || !ctx.alive) return
      const job = this.execute(ctx, command)
      if (job && JOB_COMMANDS.has(command.name)) {
        const result = await job
        if (result === 'stopped') return
      }
    }
  }

  // A build or farm "here" is pinned to where he stands now, not where he is when a plan gets to it
  pinHere (command) {
    const a = command.args || {}
    if ((command.name === 'build' && a.site === 'here') || (command.name === 'farm' && a.here)) {
      if (!a.at) a.at = this.ownerSpot()
    }
  }

  // The bot that takes a one bot job: one with nothing to do, else the first
  pickSolo (ctxs, command = null) {
    // a craft request goes to the bot already making that item for that player (so it is not made twice), then to
    // one with a craft job (it queues there)
    if (command?.name === 'craft') {
      const a = command.args
      const has = c => { const m = c.manager.get('craft'); return [m.job, ...m.queue].some(j => j && j.item === a.item && j.requester === (a.requester || this.owner)) }
      const busy = ctxs.find(has) || ctxs.find(c => c.manager.get('craft').job)
      if (busy) return busy
    }
    return ctxs.find(c => ['idle', 'following you'].includes(c.manager.status())) || ctxs[0]
  }

  oneShot (m, keep) {
    for (const n of ONE_SHOT) if (n !== keep) m.setOff(n)
  }

  // Runs one command on one bot. Returns the job's promise for commands that end on their own
  execute (ctx, command) {
    const m = ctx.manager
    const a = command.args
    switch (command.name) {
      case 'stop':
        ctx.seq++
        m.stopNow()
        return null
      case 'kill':
        for (const n of ['mine', 'come', 'give', 'follow']) m.setOff(n)
        return m.setOn('kill', { radius: a.radius, target: a.target })
      case 'guard':
        return m.setOn('guard', { radius: a.radius })
      case 'come':
        m.setOff('follow')
        return m.setOn('come', {})
      case 'follow':
        m.setOff('come')
        return m.setOn('follow', {})
      case 'stay':
        for (const n of ['follow', 'come', 'mine', 'give', 'build', 'farm', 'explore']) m.setOff(n)
        ctx.bot.pathfinder.setGoal(null)
        ctx.bot.clearControlStates()
        return null
      case 'mine':
        this.oneShot(m, 'mine')
        return m.setOn('mine', { block: a.block, blocks: a.blocks, count: a.count })
      case 'build': {
        const b = this.loadBlueprint(a.blueprint)
        if (!b) {
          this.say(ctx.bot, `I have no blueprint called ${a.blueprint}. Try !blueprints, or describe it to @crew`)
          return null
        }
        let anchor
        let facing = a.facing
        if (a.site === 'here') {
          const spot = a.at || this.ownerSpot()
          if (!spot) { this.say(ctx.bot, `I can't see you, ${this.owner}`); return null }
          anchor = spot.anchor
          facing = facing || bp.facingTowardOwner(spot.yaw)
        } else {
          anchor = new Vec3(a.site[0], a.site[1] - 1, a.site[2])
          facing = facing || b.facing
        }
        this.oneShot(m, 'build')
        return m.setOn('build', { blueprint: b, anchor, facing })
      }
      case 'expand': {
        const owner = ctx.bot.players[this.owner]?.entity
        const rec = this.builds.find(a.build, owner ? owner.position : ctx.bot.entity.position)
        if (!rec) { this.say(ctx.bot, `I know no ${a.build} the crew built`); return null }
        const base = this.loadBlueprint(rec.blueprint)
        if (!base || !base.expand) { this.say(ctx.bot, `${rec.blueprint} has no module to add`); return null }
        const bigger = withCrop(bp.expandBlueprint(base, rec.modules || 1), rec.crop)
        this.oneShot(m, 'build')
        return m.setOn('build', { blueprint: bigger, anchor: new Vec3(...rec.anchor), facing: rec.facing, modules: (rec.modules || 1) + 1, crop: rec.crop })
      }
      case 'farm': {
        let here = null
        let facing = null
        if (a.here) {
          const spot = a.at || this.ownerSpot()
          if (!spot) { this.say(ctx.bot, `I can't see you, ${this.owner}`); return null }
          here = spot.anchor
          facing = bp.facingTowardOwner(spot.yaw)
        }
        return m.setOn('farm', { crop: a.crop, here, facing })
      }
      case 'explore':
        this.oneShot(m, 'explore')
        return m.setOn('explore', { radius: a.radius })
      case 'design':
        return this.design(ctx, a)
      case 'blueprints':
        this.say(ctx.bot, `Blueprints: ${this.blueprintNames().join(', ')}`)
        return null
      case 'give':
        return m.setOn('give', {})
      case 'craft': return this.craft(ctx, a)
      case 'status':
        this.say(ctx.bot, this.statusLine(ctx))
        return null
      case 'human':
        ctx.human.setLevel(a.level)
        return null
      case 'quiet': case 'verbose':
        return null  // crew wide, set once in onOwnerMessage
    }
    return null
  }

  // A new blueprint from his words through Claude Sonnet: checked, saved to server-crew/blueprints, its material
  // list said in chat before anything gets built. Resolves 'done' or 'error'
  async design (ctx, a) {
    const bot = ctx.bot
    if (this.loadBlueprint(a.blueprint)) {
      this.say(bot, `I already have ${a.blueprint}, building that one`)
      return 'done'
    }
    if (!this.designer.enabled) {
      this.say(bot, 'Drawing new blueprints needs the API key in ~/.config/anthropic/api.env')
      return 'error'
    }
    const r = await this.designer.design(a.blueprint, a.words)
    if (r.error) {
      this.say(bot, `I couldn't draw ${a.blueprint}: ${r.error}`.slice(0, 200))
      return 'error'
    }
    const file = bp.saveBlueprint(r.blueprint, CUSTOM_BLUEPRINTS)
    log(`designed ${a.blueprint} (${r.attempts} tries), saved to ${file}`)
    const [x, y, z] = r.blueprint.size
    this.say(bot, `${a.blueprint} is ${x} by ${z}, ${y} high, it takes ${bp.describeItems(r.check.materials)}`.slice(0, 250))
    return 'done'
  }

  // A craft request to the crafter role (CraftMode in behaviors.js). Says what happens, returns the job's promise
  craft (ctx, a) {
    const mode = ctx.manager.get('craft')
    const requester = a.requester || this.owner
    const label = a.item.replace(/_/g, ' ')
    const r = mode.request({ item: a.item, requester })
    if (r === 'started') this.say(ctx.bot, `Crafting ${aOrAn(label)} for ${requester}`)
    else if (r === 'queued') this.say(ctx.bot, `I'll craft the ${label} for ${requester} after ${mode.describe().replace(/^\w+ /, 'the ')}`)
    else if (r === 'duplicate') this.say(ctx.bot, `I'm already on your ${label}, ${requester}`)
    else if (r === 'ready') this.say(ctx.bot, `Your ${label} is ready, ${requester}, bringing it`)
    const job = [mode.job, ...mode.queue].find(j => j && j.item === a.item && j.requester === requester)
    return job ? job.done : null
  }

  statusLine (ctx) {
    const b = ctx.bot
    const p = b.entity.position
    const pick = b.inventory.items().find(i => i.name.endsWith('_pickaxe'))
    return `${ctx.manager.status()}, health ${Math.round(b.health)}, food ${b.food}, at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` +
      `, ${pick ? pick.name.replace('_', ' ') : 'no pickaxe'}, human ${ctx.human.level}`
  }

  acknowledge (ctxs, command) {
    if (command.name === 'status' || command.name === 'blueprints' || command.name === 'craft') return  // craft speaks for itself
    const who = ctxs.length === this.names.length && ctxs.length > 1 ? 'Crew' : ctxs.map(c => c.bot.username).join(', ')
    const a = command.args
    const text = {
      stop: 'stopped',
      kill: `killing within ${a.radius}${a.target ? `, target ${a.target}` : ''}`,
      guard: `guarding within ${a.radius}`,
      come: 'coming',
      follow: 'following',
      stay: 'staying here',
      mine: `mining ${a.count} ${a.block}`,
      give: 'bringing what I have',
      human: `human mode ${a.level}`,
      quiet: `chat news ${this.verbosity}`,
      verbose: `chat news ${this.verbosity}`,
      build: `building ${a.blueprint}${Array.isArray(a.site) ? ` at ${a.site.join(' ')}` : ' here'}`,
      farm: `farming ${a.crop}${a.here ? ' here' : ''}`,
      expand: `adding a module to ${a.build}`,
      explore: `exploring within ${a.radius}`,
      design: `drawing a blueprint for ${a.blueprint}`
    }[command.name] || formatCommand('all', command)
    this.say(ctxs[0].bot, `${who}: ${text}`)
  }

  close () {
    this.closing = true
    for (const ctx of this.ctxs.values()) {
      try { ctx.bot.quit('closing') } catch {}
    }
    this.policy.close()
    this.rcon?.close()
  }
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const crew = new Crew(opts)
  const shutdown = () => {
    log('closing')
    crew.close()
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await crew.start()
  log(`crew ready: ${opts.names.join(', ')}, owner ${crew.owner}, fighter ${opts.run}`)
}

if (require.main === module) {
  main().catch(err => {
    log(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = { Crew, Builds }
