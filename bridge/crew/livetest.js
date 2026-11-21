// The crew's live tests (DEC-089). One self contained Node script that runs the same way on the Mac and on his
// Windows PC: it starts the crew server on a frozen bench world, runs one test, saves a top down picture and the
// results, and stops everything it started by PID.
//
//   node bridge/crew/livetest.js wheat_farm            one test (also mining_proof, bench_old, bench_new, small_hut,
//                                                      explore, translate, or several joined by commas)
//   node bridge/crew/livetest.js all                   every test in order: wheat_farm, mining_proof, bench_old,
//                                                      bench_new, bench_old, bench_new, small_hut, explore, translate
//   node bridge/crew/livetest.js all --until 22:15     no test starts after 22:15 (the Mac waiter uses this)
//   node bridge/crew/livetest.js bench_setup           makes the bench world again (the first test does it by itself)
//   node bridge/crew/livetest.js serve                 opens the bench world as the last test left it, to look around
//   node bridge/crew/livetest.js stop                  stops the crew server by its PID file
//
// Needs `python3 server.py crew-setup` once (server-crew/ with its properties, whitelist and Paper files). Results:
// runs/crew-tests/<test>.png (the latest picture), <test>.json (the latest run and up to 20 earlier ones),
// summary.txt (one paragraph per run), bench.csv (one row per bench run), and per run logs.
//
// Safety. His own world (server-crew/crew) is never opened: Paper runs with --config bench.properties and
// --world-dir bench, so the world lives in server-crew/bench and is copied back from server-crew/bench-pristine
// before every test. A test refuses to start when anything already listens on the crew port (maybe he is playing
// on his world) and when the running server's seed is not the bench seed, so the test commands (time, gamerules,
// kills, clears) can only ever reach the bench world. The test owner is CrewTester (whitelisted for the test and
// removed after), never Live_Fonam.

const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const { Vec3 } = require('vec3')

const ROOT = path.join(__dirname, '..', '..')
const CREW_DIR = path.join(ROOT, 'server-crew')
const SERVER_DIR = path.join(ROOT, 'server')
const BENCH_DIR = path.join(CREW_DIR, 'bench')
const PRISTINE = path.join(CREW_DIR, 'bench-pristine')
const BENCH_PROPS = path.join(CREW_DIR, 'bench.properties')
const PID_FILE = path.join(CREW_DIR, 'server.pid')
const BENCH_FILE = path.join(__dirname, 'bench.json')
const OUT_DIR = process.env.CREW_TESTS_DIR || path.join(ROOT, 'runs', 'crew-tests')
const CONFIG = require('./crew.config.json')
const TESTER = 'CrewTester'
const BOT = 'Crew1'
const WIN = process.platform === 'win32'
const MINUTE = 60000

const IRON = ['iron_ore', 'deepslate_iron_ore']
const COAL = ['coal_ore', 'deepslate_coal_ore']
const HOSTILE = ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'zombie_villager', 'phantom', 'silverfish', 'endermite', 'pillager', 'vindicator']
// blocks a top down view looks through, and broken blocks that do not count as digging
const SEE_THROUGH = /^(air|cave_air|void_air|light|structure_void|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|leaf_litter|firefly_bush|vine|glow_lichen|cactus_flower|open_eyeblossom|closed_eyeblossom)$/
const PLANT = /^(short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|leaf_litter|firefly_bush|vine|glow_lichen|\w+_carpet|sweet_berry_bush|seagrass|tall_seagrass|kelp|kelp_plant|\w+_mushroom|hanging_roots|cave_vines|cave_vines_plant|spore_blossom|sugar_cane|\w+_sapling|torch|wall_torch|snow|wheat|carrots|potatoes|beetroots)$/
const GOOD_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt'])
// Tree parts: a top view stops on them, but a bot set down there stands on a canopy (BUG-119: the bench spawn spot
// was on spruce leaves 12 blocks above the forest floor, so every walk and every tunnel met a drop)
const TREE = /(_leaves|_log|_wood|_stem|_hyphae|_mushroom_block|^bamboo|^mangrove_roots|^moss_carpet|^snow)$/
// changes the world makes by itself (grass spreading, leaves decaying, snow) do not mark a build's footprint
const NATURAL_SURFACE = new RegExp(`${SEE_THROUGH.source.slice(0, -2)}|grass_block|dirt|snow|\\w+_leaves)$`)
const STUCK_RE = /mining: |stuck|could not step|path took too long|gives up on/gi

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const rel = p => path.relative(ROOT, p).split(path.sep).join('/')
const pad = n => String(n).padStart(2, '0')
function fileStamp (d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

let logFile = null
function log (...a) {
  const line = `[livetest ${new Date().toTimeString().slice(0, 8)}] ${a.join(' ')}`
  console.log(line)
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n') } catch {}
  }
}

function withTimeout (promise, ms, what = 'step') {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms) })
  ]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------------------------------------------
// Files, Java and Paper

function readBench () { return JSON.parse(fs.readFileSync(BENCH_FILE, 'utf8')) }
function writeBench (bench) { fs.writeFileSync(BENCH_FILE, JSON.stringify(bench, null, 2) + '\n') }

function readProps (file) {
  const props = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    props[line.slice(0, i)] = line.slice(i + 1)
  }
  return props
}

// The crew server's own properties with the bench seed and world name, so ports and the RCON password always match
function benchProperties (crewPropsText, seed, levelName) {
  const set = { 'level-seed': String(seed), 'level-name': levelName }
  const done = new Set()
  const out = []
  for (const line of crewPropsText.split(/\r?\n/)) {
    if (!line) continue
    const key = line.includes('=') && !line.startsWith('#') ? line.slice(0, line.indexOf('=')) : null
    if (key && key in set) {
      out.push(`${key}=${set[key]}`)
      done.add(key)
    } else {
      out.push(line)
    }
  }
  for (const [k, v] of Object.entries(set)) if (!done.has(k)) out.push(`${k}=${v}`)
  return out.join('\n') + '\n'
}

function walkFiles (dir, visit, depth = 0) {
  if (depth > 8) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, visit, depth + 1)
    else visit(p)
  }
}

// Java the way server.py finds it (java_path: the first bin/java under server/jre), else the one on the PATH
function findJava () {
  const exe = WIN ? 'java.exe' : 'java'
  for (const base of [path.join(SERVER_DIR, 'jre'), path.join(CREW_DIR, 'jre')]) {
    const found = []
    walkFiles(base, p => {
      if (path.basename(p) === exe && path.basename(path.dirname(p)) === 'bin') found.push(p)
    })
    found.sort()
    if (found.length) return found[0]
  }
  return exe
}

function paperJar () {
  const own = path.join(CREW_DIR, 'paper.jar')
  return fs.existsSync(own) ? own : path.join(SERVER_DIR, 'paper.jar')
}

function offlineUuid (name) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest()
  b[6] = (b[6] & 0x0f) | 0x30
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function fileSize (f) {
  try { return fs.statSync(f).size } catch { return 0 }
}

function readFrom (f, offset) {
  try {
    const buf = fs.readFileSync(f)
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8')
  } catch { return '' }
}

// ---------------------------------------------------------------------------------------------------------------
// Processes, always by PID

function pidAlive (pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function killPid (pid, { tree = false, graceMs = 8000 } = {}) {
  if (!pidAlive(pid)) return
  if (WIN) {
    // taskkill by PID, with /T for the children this harness started through it (the crew's Python fighter)
    spawnSync('taskkill', ['/pid', String(pid), ...(tree ? ['/T'] : []), '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
  const until = Date.now() + graceMs
  while (pidAlive(pid) && Date.now() < until) await sleep(250)
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

// Before any world folder changes: a server already on the crew port may be his own world or an open bench world
async function refuseIfBusy () {
  if (!fs.existsSync(path.join(CREW_DIR, 'server.properties'))) {
    throw new Error('no crew server here yet, run  python3 server.py crew-setup  first')
  }
  if (await portOpen(CONFIG.port)) {
    throw new Error(`something already listens on port ${CONFIG.port} (maybe his own crew world), not touching it`)
  }
}

function portOpen (port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = net.connect(port, host)
    const done = v => { sock.destroy(); resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1500, () => done(false))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The bench world and the crew server

function restoreBench () {
  if (!fs.existsSync(PRISTINE)) throw new Error('no pristine bench world yet (bench_setup makes it)')
  fs.rmSync(BENCH_DIR, { recursive: true, force: true })
  fs.cpSync(PRISTINE, BENCH_DIR, { recursive: true })
}

function savePristine () {
  if (!fs.existsSync(BENCH_DIR)) throw new Error('no bench world to save')
  fs.rmSync(PRISTINE, { recursive: true, force: true })
  fs.cpSync(BENCH_DIR, PRISTINE, { recursive: true })
}

function rconSettings () {
  const p = readProps(fs.existsSync(BENCH_PROPS) ? BENCH_PROPS : path.join(CREW_DIR, 'server.properties'))
  return { port: parseInt(p['rcon.port'], 10), password: p['rcon.password'] }
}

async function startServer (s, { detached = false } = {}) {
  const props = path.join(CREW_DIR, 'server.properties')
  if (!fs.existsSync(props)) throw new Error('no crew server here yet, run  python3 server.py crew-setup  first')
  if (await portOpen(CONFIG.port)) {
    throw new Error(`something already listens on port ${CONFIG.port} (maybe his own crew world), not touching it`)
  }
  const bench = readBench()
  fs.writeFileSync(BENCH_PROPS, benchProperties(fs.readFileSync(props, 'utf8'), bench.seed, bench.level_name))
  const mem = CONFIG.server_memory || '1G'
  fs.mkdirSync(path.join(CREW_DIR, 'logs'), { recursive: true })
  const out = fs.openSync(path.join(CREW_DIR, 'logs', 'bench-console.log'), 'a')
  const java = findJava()
  const args = ['-Dcrew=1', '-Dcrewbench=1', `-Xms${mem}`, `-Xmx${mem}`, '-jar', paperJar(), '--nogui',
    '--config', 'bench.properties', '--world-dir', path.basename(BENCH_DIR)]
  const proc = spawn(java, args, { cwd: CREW_DIR, stdio: ['ignore', out, out], windowsHide: true, detached })
  fs.closeSync(out)
  s.serverExit = undefined
  proc.on('error', err => { s.serverExit = `error ${err.message}` })
  proc.on('exit', code => { s.serverExit = code ?? 'signal' })
  if (detached) proc.unref()
  s.serverPid = proc.pid
  fs.writeFileSync(PID_FILE, String(proc.pid))  // the same pid file as server.py, so crew-stop also works
  log(`crew server starting on the bench world (pid ${proc.pid}, ${mem} heap, java ${rel(java)})`)
  s.rcon = await waitRcon(s, 8 * MINUTE)
  log('crew server ready')
}

async function waitRcon (s, ms) {
  const { Rcon } = require('../rcon')
  const { port, password } = rconSettings()
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (s.serverExit !== undefined) throw new Error(`the crew server stopped while starting (${s.serverExit}), see server-crew/logs/bench-console.log`)
    const r = new Rcon('127.0.0.1', port, password)
    try {
      await withTimeout(r.connect(), 5000, 'RCON connect')
      return r
    } catch {
      try { r.close() } catch {}
    }
    await sleep(3000)
  }
  throw new Error('the crew server did not open RCON in time')
}

async function stopServer (s) {
  if (!s.serverPid) return
  if (!s.rcon && pidAlive(s.serverPid)) {
    try { s.rcon = await waitRcon({}, 8000) } catch {}
  }
  if (s.rcon) {
    try { await withTimeout(s.rcon.send('stop'), 15000, 'stop') } catch {}
    try { s.rcon.close() } catch {}
    s.rcon = null
  }
  const until = Date.now() + 90000
  while (pidAlive(s.serverPid) && s.serverExit === undefined && Date.now() < until) await sleep(500)
  if (pidAlive(s.serverPid) && s.serverExit === undefined) {
    log('the crew server did not stop by itself, ending it by PID')
    await killPid(s.serverPid, { tree: true, graceMs: 15000 })
  }
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(s.serverPid)) fs.unlinkSync(PID_FILE)
  } catch {}
  log(`crew server stopped (pid ${s.serverPid})`)
  s.serverPid = null
}

// Every test command is refused unless the running server is the bench world
async function checkSeed (s) {
  const reply = await s.rcon.send('seed')
  const m = reply.match(/\[(-?\d+)\]/) || reply.match(/(-?\d{3,})/)
  const seed = String(readBench().seed)
  if (!m || m[1] !== seed) throw new Error(`the running server's seed is ${m ? m[1] : 'unknown'}, not the bench seed ${seed}, refusing`)
}

// Game rules got snake case names in 1.21.11 (random_tick_speed), older servers use camel case (randomTickSpeed)
async function setRule (s, names, value) {
  for (const n of names) {
    let reply = ''
    try { reply = await s.rcon.send(`gamerule ${n} ${value}`) } catch { return null }
    if (!/unknown|incorrect|invalid|expected|error/i.test(reply)) return n
  }
  log(`no game rule of ${names.join(' or ')} took the value ${value}`)
  return null
}

async function prepWorld (s, spot) {
  await setRule(s, ['advance_time', 'doDaylightCycle'], 'false')
  await setRule(s, ['advance_weather', 'doWeatherCycle'], 'false')
  await setRule(s, ['spawn_phantoms', 'doInsomnia'], 'false')
  await setRule(s, ['respawn_radius', 'spawnRadius'], 0)
  await setRule(s, ['random_tick_speed', 'randomTickSpeed'], 3)
  for (const c of ['time set 1000', 'weather clear', 'difficulty normal']) await s.rcon.send(c)
  if (spot) await killHostiles(s, spot)
}

async function killHostiles (s, p) {
  for (const t of HOSTILE) await s.rcon.send(`kill @e[type=minecraft:${t},x=${p.x},y=${p.y},z=${p.z},distance=..64]`)
}

// ---------------------------------------------------------------------------------------------------------------
// The test owner and the crew

async function joinTester (s) {
  const mineflayer = require('mineflayer')
  await s.rcon.send(`whitelist add ${TESTER}`)
  const bot = mineflayer.createBot({
    host: CONFIG.host, port: CONFIG.port, username: TESTER, version: CONFIG.version, auth: 'offline', checkTimeoutInterval: 120000
  })
  s.tester = bot
  bot.on('error', err => log(`${TESTER}: ${err.message}`))
  bot.on('kicked', r => log(`${TESTER} was kicked: ${JSON.stringify(r).slice(0, 200)}`))
  bot.on('messagestr', text => { s.chat.push({ at: Date.now(), text }) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${TESTER} could not join`)), 90000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('end', r => { clearTimeout(timer); reject(new Error(`${TESTER} left: ${r}`)) })
  })
  await s.rcon.send(`gamemode creative ${TESTER}`)
  log(`${TESTER} joined (creative)`)
}

function say (s, text) {
  log(`${TESTER} says: ${text}`)
  s.tester.chat(text)
}

// Waits until the chunks covering this box are in the tester's view
async function waitArea (bot, x0, z0, x1, z1, ms) {
  const until = Date.now() + ms
  const v = new Vec3(0, 0, 0)
  while (Date.now() < until) {
    let missing = 0
    for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
      for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) {
        v.x = cx * 16
        v.z = cz * 16
        if (!bot.world.getColumnAt(v)) missing++
      }
    }
    if (!missing) return true
    await sleep(500)
  }
  return false
}

// The tester stands on the spot facing south (yaw 0 in the /tp command), where the builds go
async function ownerAt (s, spot = s.spot) {
  try { s.tester.creative.stopFlying() } catch {}
  await s.rcon.send(`tp ${TESTER} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} 0 0`)
  await waitArea(s.tester, spot.x - 40, spot.z - 40, spot.x + 40, spot.z + 40, 60000)
  await sleep(1500)
}

// A level grass site around the spot: 25 wide, 6 behind the spot and 18 in front (south), 3 blocks of dirt under
// the grass and 12 of air above it, so trees and slopes are gone. The bench world is restored before every test
async function flattenSite (s, spot) {
  const gy = spot.y - 1
  const [x1, x2, z1, z2] = [spot.x - 12, spot.x + 12, spot.z - 6, spot.z + 18]
  const replies = []
  for (const c of [
    `fill ${x1} ${gy - 3} ${z1} ${x2} ${gy - 1} ${z2} minecraft:dirt`,
    `fill ${x1} ${gy} ${z1} ${x2} ${gy} ${z2} minecraft:grass_block`,
    `fill ${x1} ${gy + 1} ${z1} ${x2} ${gy + 12} ${z2} minecraft:air`,
    `kill @e[type=minecraft:item,x=${spot.x},y=${spot.y},z=${spot.z},distance=..40]`
  ]) replies.push(await s.rcon.send(c))
  log(`site levelled at ${spot.x} ${gy} ${spot.z}: ${replies.slice(0, 3).map(r => String(r).slice(0, 60)).join(' | ')}`)
  s.flattened = { x1, x2, z1, z2, ground: gy }
}

// Out of any footprint: 3 blocks behind the spot and 3 up, hovering
async function testerAside (s) {
  await s.rcon.send(`tp ${TESTER} ${s.spot.x + 0.5} ${s.spot.y + 3} ${s.spot.z - 2.5} 0 30`)
  try { s.tester.creative.startFlying() } catch {}
}

function startCrew (s, { miner = null, translator = false } = {}) {
  // what the crew builds in a test is remembered inside the bench world (restored before every test), never in
  // the list that belongs to his own crew world
  const args = [path.join(ROOT, 'bridge', 'crew', 'crew.js'), '--owner', TESTER, '--metrics', s.metricsFile, '--bots', '1',
    '--builds', path.join(BENCH_DIR, 'crew-builds.json')]
  if (miner) args.push('--miner', miner)
  if (!translator) args.push('--no-translator')
  const out = fs.openSync(s.crewLog, 'a')
  const proc = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true })
  fs.closeSync(out)
  s.crewPid = proc.pid
  s.crewExit = undefined
  proc.on('error', err => { s.crewExit = `error ${err.message}` })
  proc.on('exit', code => { s.crewExit = code ?? 'signal' })
  fs.writeFileSync(path.join(OUT_DIR, 'crew.pid'), String(proc.pid))
  log(`crew started (pid ${proc.pid}): crew.js ${args.slice(1).join(' ')}`)
}

async function waitOnline (s, name, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (s.crewExit !== undefined) throw new Error(`the crew stopped (${s.crewExit}), see ${rel(s.crewLog)}`)
    const list = await s.rcon.send('list')
    const names = (list.split(':').slice(1).join(':') || '').split(',').map(x => x.trim())
    if (names.includes(name)) return
    await sleep(2000)
  }
  throw new Error(`${name} did not join`)
}

async function prepBot (s, name, pos, kit) {
  const c = cmd => s.rcon.send(cmd)
  await c(`gamemode survival ${name}`)
  await c(`clear ${name}`)
  await c(`effect clear ${name}`)
  await c(`tp ${name} ${pos.x + 0.5} ${pos.y} ${pos.z + 0.5} 180 0`)
  await c(`effect give ${name} minecraft:instant_health 1 4 true`)
  await c(`effect give ${name} minecraft:saturation 1 10 true`)
  for (const [item, n] of kit) await c(`give ${name} minecraft:${item} ${n}`)
  await sleep(2000)
  log(`${name} ready at ${pos.x} ${pos.y} ${pos.z} with ${kit.map(([i, n]) => `${n} ${i}`).join(', ') || 'nothing'}`)
}

// The ground column below a spot in the tester's view: the first block from the top that a top view does not see
// through (with skip, the blocks it matches are seen through too), or null when the column is not loaded
function groundAt (bot, x, z, top = 200, bottom = -64, skip = null) {
  const v = new Vec3(x, 0, z)
  if (!bot.world.getColumnAt(v)) return null
  for (let y = top; y >= bottom; y--) {
    v.y = y
    const b = bot.registry.blocksByStateId[bot.world.getBlockStateId(v)]
    if (!b || SEE_THROUGH.test(b.name) || (skip && skip.test(b.name))) continue
    return { y, name: b.name }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// What the crew reports: the metrics file (crew.js --metrics) and the server's own statistics

class MetricsTail {
  constructor (file) {
    this.file = file
    this.offset = 0
    this.partial = ''
    this.lines = []
  }

  poll () {
    let fd
    try { fd = fs.openSync(this.file, 'r') } catch { return }
    try {
      const size = fs.fstatSync(fd).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const parts = (this.partial + buf.toString('utf8')).split('\n')
      this.partial = parts.pop()
      for (const p of parts) {
        if (!p.trim()) continue
        try { this.lines.push(JSON.parse(p)) } catch {}
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  mark () { this.poll(); return this.lines.length }
  since (i) { this.poll(); return this.lines.slice(i) }

  // The line saying how a job of this bot ended, or null when the time runs out
  async waitJob (s, bot, job, ms, since) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const hit = this.since(since).find(l => l.bot === bot && l.job === job)
      if (hit) return hit
      if (s.crewExit !== undefined) return { bot, job, result: 'crew-exited' }
      await sleep(1000)
    }
    return null
  }
}

function statsFile (name) {
  return path.join(BENCH_DIR, readBench().level_name, 'stats', `${offlineUuid(name)}.json`)
}

// The server's statistics of a player (save-all writes them), categories like minecraft:mined and minecraft:used
async function statsNow (s, name = BOT) {
  try { await withTimeout(s.rcon.send('save-all'), 30000, 'save-all') } catch {}
  await sleep(300)
  try { return JSON.parse(fs.readFileSync(statsFile(name), 'utf8')).stats || {} } catch { return {} }
}

function statDiff (a, b) {
  const out = {}
  for (const [cat, vals] of Object.entries(b || {})) {
    for (const [k, n] of Object.entries(vals)) {
      const d = n - ((a?.[cat] || {})[k] || 0)
      if (d > 0) (out[cat] ||= {})[k] = d
    }
  }
  return out
}

const short = k => k.replace(/^minecraft:/, '')

function mineSummary (diff, ores) {
  let dug = 0
  let plants = 0
  let target = 0
  const other = {}
  for (const [k, n] of Object.entries(diff['minecraft:mined'] || {})) {
    const name = short(k)
    if (PLANT.test(name)) plants += n
    else dug += n
    if (ores.includes(name)) target += n
    else if (/_ore$|^ancient_debris$/.test(name)) other[name] = n
  }
  const custom = diff['minecraft:custom'] || {}
  const cm = ['walk_one_cm', 'sprint_one_cm', 'crouch_one_cm', 'swim_one_cm', 'walk_under_water_one_cm', 'climb_one_cm']
    .reduce((t, k) => t + (custom[`minecraft:${k}`] || 0), 0)
  const picked = {}
  for (const [k, n] of Object.entries(diff['minecraft:picked_up'] || {})) {
    if (/raw_|coal|diamond|emerald|lapis|redstone|copper|gold|quartz|debris/.test(k)) picked[short(k)] = n
  }
  return { blocks_dug: dug, plants_broken: plants, target_ores: target, other_ores: other, deaths: custom['minecraft:deaths'] || 0, walked_m: Math.round(cm / 100), picked_up: picked }
}

// Items in a container or a player, from "data get". The reply lists one {...} per stack
function parseItems (reply) {
  const out = {}
  const start = reply.indexOf('[')
  if (start < 0) return out
  let depth = 0
  let from = -1
  for (let i = start + 1; i < reply.length; i++) {
    const ch = reply[i]
    if (ch === '{') {
      if (depth === 0) from = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && from >= 0) {
        const el = reply.slice(from, i + 1)
        const id = el.match(/id: ?"minecraft:([a-z0-9_]+)"/)
        const count = el.match(/count: ?(\d+)/i)
        if (id) out[id[1]] = (out[id[1]] || 0) + (count ? parseInt(count[1], 10) : 1)
        from = -1
      }
    } else if (ch === ']' && depth === 0) {
      break
    }
  }
  return out
}

async function itemsAt (s, pos) {
  try { return parseItems(await s.rcon.send(`data get block ${pos.x} ${pos.y} ${pos.z} Items`)) } catch { return {} }
}

function containersNear (s, center, radius = 24) {
  const reg = s.tester.registry
  const ids = ['chest', 'trapped_chest', 'barrel'].map(n => reg.blocksByName[n]?.id).filter(x => x !== undefined)
  return s.tester.findBlocks({ point: center, matching: ids, maxDistance: radius, count: 20 })
}

async function itemsInContainersNear (s, center, radius = 24) {
  const total = {}
  for (const p of containersNear(s, center, radius)) {
    for (const [k, n] of Object.entries(await itemsAt(s, p))) total[k] = (total[k] || 0) + n
  }
  return total
}

// Where the bot is, every 2 seconds, from the server (works however far it goes)
function startPathSampling (s) {
  let busy = false
  s.pathTimer = setInterval(async () => {
    if (busy || !s.rcon) return
    busy = true
    try {
      const r = await withTimeout(s.rcon.send(`data get entity ${BOT} Pos`), 5000, 'pos')
      const m = r.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
      if (m) s.path.push({ at: Date.now(), x: Math.floor(+m[1]), y: Math.floor(+m[2]), z: Math.floor(+m[3]) })
    } catch {}
    busy = false
  }, 2000)
}

function stopPathSampling (s) {
  if (s.pathTimer) clearInterval(s.pathTimer)
  s.pathTimer = null
}

function botChat (s, fromIndex = 0) {
  const out = []
  for (const c of s.chat.slice(fromIndex)) {
    const m = String(c.text).match(/^(?:\[[^\]]*\] )*<([^>]+)> (.*)$/)
    if (m && m[1] === BOT) out.push({ at: c.at, text: m[2] })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Pictures: block snapshots from the tester's view, a top down render, and a PNG written by hand

function snapshot (bot, box) {
  const minY = bot.game?.minY ?? -64
  const maxY = minY + (bot.game?.height ?? 384) - 1
  const b = { ...box, y0: Math.max(minY, box.y0), y1: Math.min(maxY, box.y1) }
  const nx = b.x1 - b.x0 + 1
  const ny = b.y1 - b.y0 + 1
  const nz = b.z1 - b.z0 + 1
  const ids = new Int32Array(nx * ny * nz).fill(-1)
  const v = new Vec3(0, 0, 0)
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      v.x = x
      v.y = 0
      v.z = z
      if (!bot.world.getColumnAt(v)) continue
      const base = ((x - b.x0) * nz + (z - b.z0)) * ny
      for (let y = b.y0; y <= b.y1; y++) {
        v.y = y
        ids[base + y - b.y0] = bot.world.getBlockStateId(v)
      }
    }
  }
  return { box: b, nx, ny, nz, ids }
}

function stateAt (snap, x, y, z) {
  const b = snap.box
  if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || z < b.z0 || z > b.z1) return -1
  return snap.ids[((x - b.x0) * snap.nz + (z - b.z0)) * snap.ny + (y - b.y0)]
}

function topBlock (snap, reg, x, z, yTop = snap.box.y1) {
  for (let y = yTop; y >= snap.box.y0; y--) {
    const id = stateAt(snap, x, y, z)
    if (id < 0) return null
    const b = reg.blocksByStateId[id]
    if (!b || SEE_THROUGH.test(b.name)) continue
    return { name: b.name, y, id }
  }
  return null
}

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))))
const COLORS = {
  grass_block: [95, 159, 53], dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], podzol: [91, 63, 24], rooted_dirt: [144, 103, 76],
  dirt_path: [148, 121, 65], mud: [60, 57, 61], farmland: [128, 90, 58], water: [52, 95, 218], lava: [207, 92, 20],
  oak_log: [151, 121, 72], oak_planks: [162, 130, 78], composter: [120, 80, 40], cobblestone: [122, 122, 122],
  mossy_cobblestone: [110, 125, 100], stone: [136, 136, 136], deepslate: [80, 80, 86], cobbled_deepslate: [77, 77, 80],
  granite: [149, 103, 85], diorite: [188, 188, 188], andesite: [136, 136, 137], tuff: [108, 109, 102], sand: [219, 207, 163],
  red_sand: [190, 102, 33], sandstone: [216, 203, 155], gravel: [131, 127, 126], clay: [160, 166, 179], torch: [255, 214, 70],
  wall_torch: [255, 214, 70], chest: [168, 116, 44], trapped_chest: [168, 116, 44], barrel: [134, 100, 58],
  crafting_table: [140, 95, 55], furnace: [110, 110, 110], hay_block: [210, 180, 40], glass: [200, 230, 240],
  snow: [245, 250, 250], snow_block: [245, 250, 250], ice: [160, 190, 250], white_wool: [233, 236, 236], bedrock: [60, 60, 60]
}
const ORE_COLORS = {
  coal: [30, 30, 30], iron: [216, 175, 147], copper: [224, 122, 75], gold: [252, 238, 75], redstone: [200, 20, 20],
  lapis: [31, 79, 200], diamond: [93, 236, 245], emerald: [23, 221, 98], quartz: [235, 230, 220], ancient_debris: [100, 70, 60]
}
const GREY = [128, 128, 128]

function oreColor (name) {
  for (const [k, c] of Object.entries(ORE_COLORS)) if (name.includes(k)) return c
  return null
}

function blockColor (reg, name, id) {
  if (COLORS[name]) {
    if (name === 'farmland') {
      const moisture = reg.blocksByStateId[id] ? id - reg.blocksByName.farmland.minStateId : 0
      return moisture >= 7 ? [86, 55, 32] : COLORS.farmland
    }
    return COLORS[name]
  }
  const age = () => id - (reg.blocksByName[name]?.minStateId ?? id)
  if (name === 'wheat') return lerp([96, 170, 60], [222, 192, 86], age() / 7)
  if (name === 'carrots') return lerp([96, 170, 60], [235, 140, 40], age() / 7)
  if (name === 'potatoes') return lerp([96, 170, 60], [200, 170, 90], age() / 7)
  if (name === 'beetroots') return lerp([96, 170, 60], [170, 40, 50], age() / 3)
  if (/_ore$|^ancient_debris$/.test(name)) return oreColor(name) || GREY
  if (/_leaves$/.test(name)) return [60, 110, 40]
  if (/_log$|_wood$|_stem$/.test(name)) return [151, 121, 72]
  if (/_planks$|_slab$|_stairs$|_trapdoor$|_pressure_plate$/.test(name)) return /cobble|stone|brick|deepslate/.test(name) ? COLORS.cobblestone : COLORS.oak_planks
  if (/_fence|_fence_gate$/.test(name)) return [140, 112, 66]
  if (/_door$/.test(name)) return [125, 92, 52]
  if (/_bed$/.test(name)) return name === 'white_bed' ? [228, 228, 228] : [200, 40, 40]
  if (/_wall$/.test(name)) return [112, 112, 112]
  if (/_sapling$/.test(name)) return [80, 140, 50]
  if (/_wool$|_carpet$/.test(name)) return [220, 220, 220]
  if (/terracotta|concrete/.test(name)) return [160, 100, 80]
  return GREY
}

const shade = (c, f) => c.map(v => Math.max(0, Math.min(255, Math.round(v * f))))

// region: {x0, z0, x1, z1}. color(x, z) gives [r, g, b] or null. markers: [{x, z, color, style: fill|outline|dot}]
function renderPng (region, color, markers = []) {
  const w = region.x1 - region.x0 + 1
  const h = region.z1 - region.z0 + 1
  const scale = Math.max(2, Math.min(12, Math.floor(720 / Math.max(w, h))))
  const W = w * scale
  const H = h * scale
  const rgb = Buffer.alloc(W * H * 3)
  const put = (px, py, c) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return
    const i = (py * W + px) * 3
    rgb[i] = c[0]
    rgb[i + 1] = c[1]
    rgb[i + 2] = c[2]
  }
  for (let z = region.z0; z <= region.z1; z++) {
    for (let x = region.x0; x <= region.x1; x++) {
      const c = color(x, z) || [40, 40, 40]
      const edge = scale >= 6 ? shade(c, 0.9) : c
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const onEdge = dx === scale - 1 || dy === scale - 1
          put((x - region.x0) * scale + dx, (z - region.z0) * scale + dy, onEdge ? edge : c)
        }
      }
    }
  }
  for (const m of markers) {
    if (m.x < region.x0 || m.x > region.x1 || m.z < region.z0 || m.z > region.z1) continue
    const px = (m.x - region.x0) * scale
    const py = (m.z - region.z0) * scale
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const border = dx === 0 || dy === 0 || dx === scale - 1 || dy === scale - 1
        const inner = dx >= scale / 3 && dx < scale - scale / 3 && dy >= scale / 3 && dy < scale - scale / 3
        if (m.style === 'fill' || (m.style === 'outline' && border) || (m.style === 'dot' && inner)) put(px + dx, py + dy, m.color)
      }
    }
  }
  return { png: encodePng(W, H, rgb), width: W, height: H, scale }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// An 8 bit RGB PNG: every row starts with filter byte 0, the rows are deflated with zlib
function encodePng (w, h, rgb) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// The box each kind of picture snapshots: builds go south of the spot, mining goes down, exploring goes wide
function snapshotBox (kind, spot) {
  if (kind === 'mine') return { x0: spot.x - 64, x1: spot.x + 64, z0: spot.z - 64, z1: spot.z + 64, y0: -64, y1: spot.y + 8 }
  if (kind === 'path') return { x0: spot.x - 80, x1: spot.x + 80, z0: spot.z - 80, z1: spot.z + 80, y0: spot.y - 30, y1: spot.y + 40 }
  return { x0: spot.x - 20, x1: spot.x + 20, z0: spot.z - 12, z1: spot.z + 28, y0: spot.y - 10, y1: spot.y + 16 }
}

// Columns where any block changed between two snapshots, with what changed
function changedColumns (before, after, reg) {
  const out = new Map()
  const b = after.box
  const counts = {}
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      for (let y = b.y0; y <= b.y1; y++) {
        const p = stateAt(before, x, y, z)
        const q = stateAt(after, x, y, z)
        if (p < 0 || q < 0 || p === q) continue
        const pn = reg.blocksByStateId[p]?.name || 'unknown'
        const qn = reg.blocksByStateId[q]?.name || 'unknown'
        if (pn !== qn) {
          counts[pn] = (counts[pn] || 0) - 1
          counts[qn] = (counts[qn] || 0) + 1
        }
        const key = `${x},${z}`
        const col = out.get(key) || { x, z, dugMinY: null, ore: null, torch: false, placed: false, significant: false }
        if (!(NATURAL_SURFACE.test(pn) && NATURAL_SURFACE.test(qn))) col.significant = true
        const solidBefore = !SEE_THROUGH.test(pn) && pn !== 'water' && pn !== 'lava'
        if (/_ore$|^ancient_debris$/.test(pn) && !/_ore$/.test(qn)) col.ore = pn
        if ((qn === 'torch' || qn === 'wall_torch') && pn !== qn) col.torch = true
        if (solidBefore && SEE_THROUGH.test(qn)) col.dugMinY = col.dugMinY === null ? y : Math.min(col.dugMinY, y)
        if (!SEE_THROUGH.test(qn)) col.placed = true
        out.set(key, col)
      }
    }
  }
  const net = Object.fromEntries(Object.entries(counts).filter(([, n]) => n !== 0).sort((a, c) => c[1] - a[1]))
  return { cols: out, net }
}

function bboxOf (points, pad) {
  if (!points.length) return null
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z)
  }
  return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad }
}

function clampRegion (r, spot, half) {
  return {
    x0: Math.max(r.x0, spot.x - half), x1: Math.min(r.x1, spot.x + half),
    z0: Math.max(r.z0, spot.z - half), z1: Math.min(r.z1, spot.z + half)
  }
}

// Draws the test's result: a build or farm as it stands, a mine as its tunnels by depth, an exploration as its path
function savePicture (s, kind) {
  const reg = s.tester.registry
  const { cols, net } = changedColumns(s.before, s.after, reg)
  const spot = s.spot
  const changed = [...cols.values()]
  const pathPts = s.path.map(p => ({ x: p.x, z: p.z, y: p.y }))
  let region
  if (kind === 'build') {
    region = bboxOf([...changed.filter(c => c.significant), { x: spot.x - 2, z: spot.z - 2 }, { x: spot.x + 2, z: spot.z + 2 }], 3)
    region = clampRegion(region, spot, 40)
  } else {
    const extra = kind === 'path' ? (s.finds || []) : []
    region = bboxOf([...changed, ...pathPts, ...extra, { x: spot.x - 8, z: spot.z - 8 }, { x: spot.x + 8, z: spot.z + 8 }], 4)
    region = clampRegion(region, spot, 128)
  }
  // height shading over what the picture shows
  const tops = new Map()
  let yMin = Infinity
  let yMax = -Infinity
  for (let x = region.x0; x <= region.x1; x++) {
    for (let z = region.z0; z <= region.z1; z++) {
      const t = topBlock(s.after, reg, x, z)
      if (!t) continue
      tops.set(`${x},${z}`, t)
      yMin = Math.min(yMin, t.y)
      yMax = Math.max(yMax, t.y)
    }
  }
  const lit = t => shade(blockColor(reg, t.name, t.id), 0.82 + 0.36 * (t.y - yMin) / Math.max(1, yMax - yMin))
  const deep = y => lerp([60, 30, 100], [205, 190, 240], (y - (-64)) / Math.max(1, spot.y + 64))
  const pathCells = new Map()
  for (const p of pathPts) {
    const k = `${p.x},${p.z}`
    if (!pathCells.has(k) || pathCells.get(k) > p.y) pathCells.set(k, p.y)
  }
  let color
  if (kind === 'build') {
    color = (x, z) => { const t = tops.get(`${x},${z}`); return t ? lit(t) : null }
  } else if (kind === 'mine') {
    color = (x, z) => {
      const k = `${x},${z}`
      const col = cols.get(k)
      if (col?.ore) return oreColor(col.ore) || GREY
      if (col?.torch) return COLORS.torch
      if (col && col.dugMinY !== null) return deep(col.dugMinY)
      if (pathCells.has(k) && pathCells.get(k) < spot.y - 2) return deep(pathCells.get(k))
      const t = tops.get(k)
      return t ? shade(lit(t), 0.45) : null
    }
  } else {
    color = (x, z) => {
      const k = `${x},${z}`
      const t = tops.get(k)
      const base = t ? lit(t) : null
      if (pathCells.has(k)) return base ? lerp(base, [255, 255, 255], 0.6) : [230, 230, 230]
      return base
    }
  }
  const markers = [{ x: spot.x, z: spot.z, color: [230, 30, 30], style: 'outline' }]
  if (s.botStart) markers.push({ x: s.botStart.x, z: s.botStart.z, color: [230, 30, 30], style: 'dot' })
  for (const f of s.finds || []) markers.push({ x: f.x, z: f.z, color: [230, 40, 230], style: 'fill' })
  const { png, width, height, scale } = renderPng(region, color, markers)
  const latest = path.join(OUT_DIR, `${s.name}.png`)
  fs.writeFileSync(latest, png)
  fs.writeFileSync(path.join(OUT_DIR, `${s.name}-${s.stamp}.png`), png)
  log(`picture ${rel(latest)} (${width} by ${height} pixels, ${scale} per block)`)
  return {
    file: rel(latest),
    region,
    pixels_per_block: scale,
    key: kind === 'mine'
      ? 'north is up. Tunnels are coloured by depth (dark purple deep, pale lavender shallow), mined ore in its own colour (iron tan, coal black, copper orange, diamond cyan), torches yellow, the surface dimmed. The red square is the spot, the red dot where the bot started'
      : kind === 'path'
        ? 'north is up. The path the bot walked is drawn light over the ground, finds it reported are magenta, the red square is the spot'
        : 'north is up, the ground and the build as seen from above, brighter is higher. The red square is where the owner stood',
    blocks_changed: net
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

// the hut takes about 34 logs (12 corners, the rest as planks, slabs, a door, sticks and a table), so with 32 it
// also has to chop a tree or two. The farm takes 28 border logs and 3 for the composter and its table, 2 water
// buckets fill the 7 long channel, the chest takes the harvest
// The kit a player would bring, so the build and the farming get tested (gathering has its own test). The hut
// takes 34 logs (12 corners, 22 as planks for walls, floor, 25 slabs, a door, sticks and a crafting table). The
// farm takes 28 border logs, 7 slabs and a crafting table for the composter, 2 water buckets for the 7 long
// channel (two sources make the rest), seeds for 27 spots, a hoe, and a chest for the harvest
const BUILD_KIT_HUT = [['oak_log', 36], ['white_bed', 1], ['coal', 4], ['iron_axe', 1], ['iron_pickaxe', 1], ['bread', 16]]
const FARM_KIT = [['oak_log', 28], ['oak_slab', 7], ['crafting_table', 1], ['water_bucket', 2], ['wheat_seeds', 40], ['iron_hoe', 1], ['chest', 1], ['bread', 16]]

const TESTS = {
  wheat_farm: { minutes: 45, picture: 'build', kit: FARM_KIT, flatten: true, run: testWheatFarm },
  mining_proof: { minutes: 52, picture: 'mine', kit: [['stone_pickaxe', 1]], run: testMiningProof },
  bench_old: { minutes: 20, picture: 'mine', miner: 'old', bench: true, run: testBench },
  bench_new: { minutes: 20, picture: 'mine', miner: 'new', bench: true, run: testBench },
  small_hut: { minutes: 30, picture: 'build', kit: BUILD_KIT_HUT, flatten: true, run: testSmallHut },
  explore: { minutes: 15, picture: 'path', kit: [['stone_sword', 1], ['bread', 16], ['torch', 16]], run: testExplore },
  translate: { minutes: 5, picture: null, translator: true, kit: [['bread', 4]], run: testTranslate }
}
const ORDER = ['wheat_farm', 'mining_proof', 'bench_old', 'bench_new', 'bench_old', 'bench_new', 'small_hut', 'explore', 'translate']

function jobStep (command, t0, hit) {
  return {
    command,
    result: hit ? hit.result : 'capped',
    minutes: round((Date.now() - t0) / MINUTE),
    error: hit?.error || null,
    crew_stats: hit?.stats || null
  }
}

// A build from the spot: the owner stands there facing south, the bot builds, the owner steps out of the way
async function buildStep (s, command, capMin) {
  await ownerAt(s)
  const m = s.metrics.mark()
  const t0 = Date.now()
  say(s, command)
  await sleep(5000)
  await testerAside(s)
  const hit = await s.metrics.waitJob(s, BOT, 'build', capMin * MINUTE, m)
  if (!hit) {
    say(s, '!stop')
    await sleep(2000)
  }
  const step = jobStep(command, t0, hit)
  step.crew_news = s.metrics.since(m).filter(l => l.bot === BOT && l.event).map(l => l.text).slice(-25)
  return step
}

async function testWheatFarm (s) {
  const statsStart = await statsNow(s)
  const build = await buildStep(s, '!build wheat_farm here', 25)
  const r = { steps: [build] }
  // one harvest, replant and store cycle within minutes: crops get 100 times the random ticks (bench world only)
  await setRule(s, ['random_tick_speed', 'randomTickSpeed'], 300)
  const base = await statsNow(s)
  await ownerAt(s)
  const m = s.metrics.mark()
  const t1 = Date.now()
  say(s, '!farm wheat')
  await sleep(5000)
  await testerAside(s)
  const out = { command: '!farm wheat', harvested: 0, replanted: 0, stored_wheat: 0, minutes_to_cycle: null }
  const until = Date.now() + 15 * MINUTE
  while (Date.now() < until && s.crewExit === undefined) {
    await sleep(20000)
    const d = statDiff(base, await statsNow(s))
    out.harvested = (d['minecraft:mined'] || {})['minecraft:wheat'] || 0
    out.replanted = (d['minecraft:used'] || {})['minecraft:wheat_seeds'] || 0
    out.stored_wheat = (await itemsInContainersNear(s, s.spot, 24)).wheat || 0
    if (out.harvested > 0 && out.replanted > 0 && out.stored_wheat > 0) {
      out.minutes_to_cycle = round((Date.now() - t1) / MINUTE)
      break
    }
  }
  say(s, '!stop')
  await sleep(2000)
  await setRule(s, ['random_tick_speed', 'randomTickSpeed'], 3)
  out.result = out.minutes_to_cycle !== null ? 'cycle' : (s.crewExit !== undefined ? 'crew-exited' : 'capped')
  out.minutes = round((Date.now() - t1) / MINUTE)
  out.crew_news = s.metrics.since(m).filter(l => l.bot === BOT && (l.event || l.job)).map(l => l.text || `${l.job} ${l.result}`).slice(-25)
  r.steps.push(out)
  const d = statDiff(statsStart, await statsNow(s))
  r.placed = Object.fromEntries(Object.entries(d['minecraft:used'] || {}).map(([k, n]) => [short(k), n]).filter(([k]) => !/_(pickaxe|axe|shovel|hoe|sword)$/.test(k)))
  r.ok = build.result === 'done' && out.result === 'cycle'
  return r
}

async function mineStep (s, command, ores, capMin) {
  const base = await statsNow(s)
  const logStart = fileSize(s.crewLog)
  const m = s.metrics.mark()
  const t0 = Date.now()
  say(s, command)
  let hit = await s.metrics.waitJob(s, BOT, 'mine', capMin * MINUTE, m)
  let result = hit ? hit.result : 'capped'
  if (!hit) {
    say(s, '!stop')
    await sleep(3000)
    hit = s.metrics.since(m).find(l => l.bot === BOT && l.job === 'mine') || null
    if (hit && hit.result !== 'stopped') result = hit.result
  }
  const minutes = (Date.now() - t0) / MINUTE
  const sum = mineSummary(statDiff(base, await statsNow(s)), ores)
  const stuckLog = (readFrom(s.crewLog, logStart).match(STUCK_RE) || []).length
  const deathsSeen = s.metrics.since(m).filter(l => l.bot === BOT && l.death).length
  const news = s.metrics.since(m).filter(l => l.bot === BOT && l.event).map(l => l.text)
  return {
    command,
    result,
    minutes: round(minutes),
    blocks_dug: sum.blocks_dug,
    target_ores: sum.target_ores,
    ores_per_100_blocks: sum.blocks_dug ? round(100 * sum.target_ores / sum.blocks_dug) : 0,
    minutes_per_ore: sum.target_ores ? round(minutes / sum.target_ores) : null,
    deaths: Math.max(sum.deaths, deathsSeen),
    stuck_events: Number.isFinite(hit?.stats?.stuck) ? hit.stats.stuck : stuckLog,
    stuck_log_lines: stuckLog,
    other_ores: sum.other_ores,
    picked_up: sum.picked_up,
    plants_broken: sum.plants_broken,
    walked_m: sum.walked_m,
    crew_stats: hit?.stats || null,
    crew_news: news.slice(-25)
  }
}

async function testMiningProof (s) {
  const steps = []
  steps.push(await mineStep(s, `!${BOT} mine iron 5`, IRON, 25))
  steps.push(await mineStep(s, `!${BOT} mine coal 10`, COAL, 25))
  const where = await itemsInContainersNear(s, s.botStart, 16)
  const r = { steps, ore_in_chests_near_start: where }
  r.ok = steps.every(x => x.result === 'done')
  return r
}

async function testBench (s) {
  const bench = readBench()
  const ores = /coal/.test(bench.bench_job) ? COAL : IRON
  const step = await mineStep(s, bench.bench_job, ores, bench.bench_minutes || 15)
  // numbers alone are not a pass: 0 ores means the miner never got going (BUG-119)
  return { miner: s.def.miner, steps: [step], ok: step.result !== 'crew-exited' && (step.target_ores || 0) > 0 }
}

async function testSmallHut (s) {
  const statsStart = await statsNow(s)
  const step = await buildStep(s, '!build small_hut here', 25)
  const d = statDiff(statsStart, await statsNow(s))
  const placed = Object.fromEntries(Object.entries(d['minecraft:used'] || {}).map(([k, n]) => [short(k), n]).filter(([k]) => !/_(pickaxe|axe|shovel|hoe|sword)$/.test(k)))
  return { steps: [step], placed, ok: step.result === 'done' }
}

function coordsIn (text) {
  const m = text.match(/(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)/)
  if (m) return { x: +m[1], y: +m[2], z: +m[3] }
  const m2 = text.match(/(-?\d+)[ ,]+(-?\d+)/)
  return m2 ? { x: +m2[1], y: null, z: +m2[2] } : null
}

async function testExplore (s) {
  await ownerAt(s)
  const m = s.metrics.mark()
  const c0 = s.chat.length
  const t0 = Date.now()
  say(s, `!${BOT} explore 64`)
  const hit = await s.metrics.waitJob(s, BOT, 'explore', 12 * MINUTE, m)
  if (!hit) {
    say(s, '!stop')
    await sleep(2000)
  }
  const lines = botChat(s, c0).map(l => l.text)
  const finds = lines.filter(l => coordsIn(l) && !/^(I died|Crew)/.test(l))
  s.finds = finds.map(coordsIn).filter(Boolean)
  const step = jobStep(`!${BOT} explore 64`, t0, hit)
  const far = s.path.reduce((mx, p) => Math.max(mx, Math.hypot(p.x - s.spot.x, p.z - s.spot.z)), 0)
  const last = s.path[s.path.length - 1]
  step.farthest_blocks = Math.round(far)
  step.back_within_blocks = last ? Math.round(Math.hypot(last.x - s.botStart.x, last.z - s.botStart.z)) : null
  return { steps: [step], finds, chat: lines.slice(-60), ok: step.result === 'done' && finds.length > 0 }
}

async function testTranslate (s) {
  await ownerAt(s)
  const c0 = s.chat.length
  const t0 = Date.now()
  const line = '@crew build me a small house here'
  say(s, line)
  let reply = null
  while (!reply && Date.now() - t0 < 90000 && s.crewExit === undefined) {
    await sleep(1000)
    reply = botChat(s, c0).find(l => /^(On it|Can't do that|I did not get|the translator|API )/i.test(l.text)) || null
  }
  say(s, '!stop')
  await sleep(2000)
  return {
    steps: [{ command: line, reply: reply ? reply.text : null, seconds: reply ? round((reply.at - t0) / 1000, 1) : null }],
    chat: botChat(s, c0).map(l => l.text).slice(-10),
    ok: !!reply && /!build small_hut/.test(reply.text)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One test from start to end, and the one time bench world setup

function newSession (name) {
  const stamp = fileStamp()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  return {
    name,
    def: TESTS[name] || {},
    stamp,
    chat: [],
    path: [],
    finds: [],
    metricsFile: path.join(OUT_DIR, `${name}-${stamp}-metrics.jsonl`),
    crewLog: path.join(OUT_DIR, `${name}-${stamp}-crew.log`)
  }
}

async function cleanup (s) {
  stopPathSampling(s)
  if (s.crewPid) {
    if (s.crewExit === undefined) log(`stopping the crew (pid ${s.crewPid})`)
    await killPid(s.crewPid, { tree: true })
    try { fs.unlinkSync(path.join(OUT_DIR, 'crew.pid')) } catch {}
    s.crewPid = null
  }
  if (s.tester) {
    try { s.tester.quit('test done') } catch {}
    s.tester = null
    await sleep(1000)
  }
  if (s.rcon) {
    try { await withTimeout(s.rcon.send(`whitelist remove ${TESTER}`), 5000, 'whitelist') } catch {}
    try { await withTimeout(setRule(s, ['random_tick_speed', 'randomTickSpeed'], 3), 5000, 'gamerule') } catch {}
  }
  await stopServer(s)
}

// A square ring of candidate centres around (x, z), 8 blocks apart, the same order every time
function ring (x, z, r) {
  if (r === 0) return [[x, z]]
  const out = []
  for (let d = -r; d < r; d += 8) out.push([x + d, z - r])
  for (let d = -r; d < r; d += 8) out.push([x + r, z + d])
  for (let d = r; d > -r; d -= 8) out.push([x + d, z + r])
  for (let d = r; d > -r; d -= 8) out.push([x - r, z + d])
  return out
}

// The area the tests use, all grass or dirt with no trees or water, at most tol blocks of height difference:
// 8 blocks to each side of the spot, 4 behind it and 12 in front (south, where the builds go)
function flatSpot (bot, cx, cz, tol, cache = null) {
  let lo = Infinity
  let hi = -Infinity
  let here = null
  for (let x = cx - 8; x <= cx + 8; x++) {
    for (let z = cz - 4; z <= cz + 12; z++) {
      const key = `${x},${z}`
      let g = cache?.get(key)
      if (!g) {
        g = groundAt(bot, x, z)
        if (g && cache) cache.set(key, g)
      }
      if (!g || !GOOD_GROUND.has(g.name)) return null
      lo = Math.min(lo, g.y)
      hi = Math.max(hi, g.y)
      if (hi - lo > tol) return null
      if (x === cx && z === cz) here = g.y
    }
  }
  return { ground: here }
}

async function viewAround (s, x, z, half = 16) {
  if (await waitArea(s.tester, x - half, z - half, x + half, z + 16, 10)) return
  await s.rcon.send(`tp ${TESTER} ${x + 0.5} 200 ${z + 0.5}`)
  try { s.tester.creative.startFlying() } catch {}
  await waitArea(s.tester, x - half, z - half, x + half, z + 16, 45000)
}

// How far from the spawn the spot search looks. 160 found nothing on seed 20261030 (old growth spruce taiga all
// around the spawn), the plains at 17 88 -198 is the first flat grass (BUG-119)
const SPOT_RADIUS = 256

async function findSpot (s) {
  const t = s.tester
  const sp = t.spawnPoint && (t.spawnPoint.x || t.spawnPoint.z || t.spawnPoint.y) ? t.spawnPoint.floored() : t.entity.position.floored()
  s.spawn = sp
  const cache = new Map()
  for (const tol of [1, 2]) {
    for (let r = 0; r <= SPOT_RADIUS; r += 8) {
      for (const [cx, cz] of ring(sp.x, sp.z, r)) {
        await viewAround(s, cx, cz)
        const ok = flatSpot(t, cx, cz, tol, cache)
        if (ok) {
          log(`flat spot at ${cx} ${ok.ground + 1} ${cz} (${r} blocks from the spawn, height spread at most ${tol})`)
          return new Vec3(cx, ok.ground + 1, cz)
        }
      }
    }
  }
  await viewAround(s, sp.x, sp.z)
  const g = groundAt(t, sp.x, sp.z, 200, -64, TREE)
  log(`no flat spot within ${SPOT_RADIUS} blocks of the spawn, using the ground under the spawn`)
  return new Vec3(sp.x, (g ? g.y : sp.y) + 1, sp.z)
}

async function benchSetup (s) {
  log('making the bench world from the seed (once): a fresh world, a spot, the chunks around it, then a pristine copy')
  await refuseIfBusy()
  if (fs.existsSync(PRISTINE)) log('an older pristine bench world exists, it gets replaced')
  fs.rmSync(BENCH_DIR, { recursive: true, force: true })
  try {
    await startServer(s)
    await checkSeed(s)
    await prepWorld(s, null)
    await joinTester(s)
    const bench = readBench()
    let spot = bench.spot ? new Vec3(...bench.spot) : null
    if (spot) {
      await viewAround(s, spot.x, spot.z)
      if (!flatSpot(s.tester, spot.x, spot.z, 2)) {
        log(`the saved spot ${spot} is not flat grass in this world, looking again`)
        spot = null
      }
    }
    if (!spot) {
      spot = await findSpot(s)
      bench.spot = [spot.x, spot.y, spot.z]
      bench.spawn = s.spawn ? [s.spawn.x, s.spawn.y, s.spawn.z] : null
      bench.found = new Date().toISOString()
      writeBench(bench)
    }
    // the chunks within about 190 blocks of the spot exist before the copy, with the animals they were made with
    for (const dx of [-96, 0, 96]) {
      for (const dz of [-96, 0, 96]) {
        await s.rcon.send(`tp ${TESTER} ${spot.x + dx + 0.5} 200 ${spot.z + dz + 0.5}`)
        try { s.tester.creative.startFlying() } catch {}
        await waitArea(s.tester, spot.x + dx - 64, spot.z + dz - 64, spot.x + dx + 64, spot.z + dz + 64, 90000)
        await sleep(2000)
      }
    }
    s.spot = spot
    await ownerAt(s, spot)
  } finally {
    await cleanup(s)
  }
  savePristine()
  log(`pristine bench world saved in ${rel(PRISTINE)}`)
}

function summaryLine (r) {
  const when = new Date(r.started)
  const at = r.spot ? ` at ${r.spot.join(' ')}` : ''
  const head = `${when.toDateString().slice(4, 10)} ${pad(when.getHours())}:${pad(when.getMinutes())} ${r.test}${at} on ${r.machine}: ${r.ok ? 'passed' : 'not passed'}`
  const parts = [head]
  if (r.error) parts.push(`error ${r.error}`)
  for (const st of r.steps || []) {
    if (st.blocks_dug !== undefined) {
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes with ${st.target_ores} ore in ${st.blocks_dug} blocks dug (${st.ores_per_100_blocks} per 100 blocks, ${st.minutes_per_ore ?? 'no'} minutes per ore), ${st.deaths} deaths, ${st.stuck_events} stuck events`)
    } else if (st.harvested !== undefined) {
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes, ${st.harvested} wheat harvested, ${st.replanted} seeds planted, ${st.stored_wheat} wheat in chests`)
    } else if (st.reply !== undefined) {
      parts.push(`"${st.command}" got the reply "${st.reply}"`)
    } else if (st.crew_stats && st.crew_stats.reached !== undefined) {
      const cs = st.crew_stats
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes, ${cs.reached} of ${cs.reached + cs.failed} targets reached, ${cs.walked} walked`)
    } else {
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes${st.error ? ` (${st.error})` : ''}`)
    }
  }
  if (r.finds) parts.push(`${r.finds.length} finds reported`)
  if (r.picture) parts.push(`picture ${r.picture.file}`)
  return parts.join('. ') + '.'
}

function appendBenchCsv (r) {
  const file = path.join(OUT_DIR, 'bench.csv')
  const st = (r.steps || [])[0] || {}
  const header = 'started,test,miner,machine,result,minutes,blocks_dug,target_ores,ores_per_100_blocks,minutes_per_ore,deaths,stuck_events,spot\n'
  if (!fs.existsSync(file)) fs.writeFileSync(file, header)
  else {
    // the spot column came with BUG-119, older rows get it empty
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    if (!lines[0].endsWith(',spot')) fs.writeFileSync(file, [header.trim(), ...lines.slice(1).filter(Boolean).map(l => l + ',')].join('\n') + '\n')
  }
  const row = [r.started, r.test, r.miner || '', r.machine, st.result ?? (r.error ? 'error' : ''), st.minutes ?? '', st.blocks_dug ?? '',
    st.target_ores ?? '', st.ores_per_100_blocks ?? '', st.minutes_per_ore ?? '', st.deaths ?? '', st.stuck_events ?? '', (r.spot || []).join(' ')]
  fs.appendFileSync(file, row.map(v => String(v).replace(/,/g, ' ')).join(',') + '\n')
}

function saveResult (name, result) {
  const file = path.join(OUT_DIR, `${name}.json`)
  let doc = { test: name, latest: null, runs: [] }
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  doc.latest = result
  doc.runs = [...(doc.runs || []), result].slice(-20)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  fs.appendFileSync(path.join(OUT_DIR, 'summary.txt'), summaryLine(result) + '\n')
  if (TESTS[name]?.bench) appendBenchCsv(result)
  log(`results in ${rel(file)}`)
}

let current = null

async function runTest (name) {
  const def = TESTS[name]
  const s = newSession(name)
  current = s
  logFile = path.join(OUT_DIR, `${name}-${s.stamp}.log`)
  const bench = readBench()
  const result = {
    test: name,
    started: new Date().toISOString(),
    machine: os.hostname(),
    platform: process.platform,
    seed: bench.seed,
    miner: def.miner || null,
    logs: { harness: rel(logFile), crew: rel(s.crewLog), metrics: rel(s.metricsFile) }
  }
  log(`test ${name} starts`)
  try {
    await refuseIfBusy()
    if (!fs.existsSync(PRISTINE)) {
      await benchSetup(s)
      Object.assign(s, { chat: [], path: [] })
    }
    const spotArr = process.env.CREW_SPOT ? process.env.CREW_SPOT.split(',').map(Number) : readBench().spot
    if (spotArr && spotArr.some(n => !Number.isFinite(n))) throw new Error(`CREW_SPOT ${process.env.CREW_SPOT} is not x,y,z`)
    if (!spotArr) throw new Error('the bench world has no spot, run bench_setup')
    s.spot = new Vec3(...spotArr)
    result.spot = spotArr
    restoreBench()
    await startServer(s)
    await checkSeed(s)
    await prepWorld(s, s.spot)
    await joinTester(s)
    await ownerAt(s)
    if (def.flatten) {
      // a build test levels its own site first, the way a player picks flat ground: the build and the farming get
      // tested, not the hill (the first bench spot was the spawn in a spruce forest, BUG-119)
      await flattenSite(s, s.spot)
      await ownerAt(s)
    }
    s.metrics = new MetricsTail(s.metricsFile)
    startCrew(s, { miner: def.miner, translator: def.translator })
    await waitOnline(s, BOT, 4 * MINUTE)
    const g = groundAt(s.tester, s.spot.x + 2, s.spot.z - 2, 200, -64, TREE)
    s.botStart = new Vec3(s.spot.x + 2, g ? g.y + 1 : s.spot.y, s.spot.z - 2)
    await prepBot(s, BOT, s.botStart, def.bench ? bench.bench_kit : def.kit)
    await killHostiles(s, s.spot)
    if (def.picture) s.before = snapshot(s.tester, snapshotBox(def.picture, s.spot))
    startPathSampling(s)
    Object.assign(result, await withTimeout(def.run(s), (def.minutes + 5) * MINUTE, `the ${name} test`))
    stopPathSampling(s)
    if (def.picture && s.tester) {
      await sleep(1500)
      s.after = snapshot(s.tester, snapshotBox(def.picture, s.spot))
      result.picture = savePicture(s, def.picture)
    }
  } catch (err) {
    result.ok = false
    result.error = err.message
    log(`test ${name} failed: ${err.stack || err.message}`)
    // a picture of how far it got, when the world is still in view
    if (def.picture && s.before && s.tester && !result.picture) {
      try {
        s.after = snapshot(s.tester, snapshotBox(def.picture, s.spot))
        result.picture = savePicture(s, def.picture)
      } catch (e) {
        log(`no picture: ${e.message}`)
      }
    }
  } finally {
    try { await cleanup(s) } catch (err) { log(`cleanup: ${err.message}`) }
    result.ended = new Date().toISOString()
    result.minutes = round((Date.parse(result.ended) - Date.parse(result.started)) / MINUTE)
    result.path = s.path.filter((p, i) => i % Math.max(1, Math.ceil(s.path.length / 400)) === 0).map(p => [p.x, p.y, p.z])
    saveResult(name, result)
    current = null
  }
  log(`test ${name} ended: ${result.ok ? 'passed' : 'not passed'}`)
  return result
}

function pastTime (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes() > h * 60 + m
}

async function stopByPidFile () {
  let pid = null
  try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) } catch {}
  if (!pidAlive(pid)) {
    log('the crew server is not running')
    return
  }
  const s = { serverPid: pid }
  try { s.rcon = await waitRcon({}, 10000) } catch {}
  await stopServer(s)
}

async function main () {
  const argv = process.argv.slice(2)
  const what = argv[0]
  const ui = argv.indexOf('--until')
  const until = ui >= 0 ? argv[ui + 1] : null
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const pidFile = path.join(OUT_DIR, 'livetest.pid')
  fs.writeFileSync(pidFile, String(process.pid))
  const onSignal = async sig => {
    log(`${sig}, cleaning up`)
    if (current) {
      try { await cleanup(current) } catch {}
    }
    try { fs.unlinkSync(pidFile) } catch {}
    process.exit(1)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    if (what === 'all' || (what && what.split(',').every(n => TESTS[n]))) {
      const names = what === 'all' ? ORDER : what.split(',')
      const results = []
      for (const name of names) {
        if (until && pastTime(until)) {
          log(`it is past ${until}, ${name} and the tests after it are not run`)
          break
        }
        results.push(await runTest(name))
      }
      log(`done: ${results.map(r => `${r.test} ${r.ok ? 'passed' : 'not passed'}`).join(', ')}`)
      if (results.some(r => !r.ok)) process.exitCode = 1
    } else if (what === 'bench_setup') {
      const s = newSession('bench_setup')
      current = s
      logFile = path.join(OUT_DIR, `bench_setup-${s.stamp}.log`)
      await benchSetup(s)
    } else if (what === 'serve') {
      const s = newSession('serve')
      await refuseIfBusy()
      if (!fs.existsSync(BENCH_DIR)) restoreBench()
      await startServer(s, { detached: true })
      await checkSeed(s)
      s.rcon.close()
      log(`the bench world is open on port ${CONFIG.port} as the last test left it (pid ${s.serverPid}), stop it with: node bridge/crew/livetest.js stop`)
    } else if (what === 'stop') {
      await stopByPidFile()
    } else {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 24).join('\n'))
      process.exitCode = 2
    }
  } finally {
    try { fs.unlinkSync(pidFile) } catch {}
  }
  // mineflayer and RCON sockets can keep the event loop alive
  setTimeout(() => process.exit(process.exitCode || 0), 500)
}

if (require.main === module) {
  main().catch(err => {
    log(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = {
  benchProperties, offlineUuid, parseItems, statDiff, mineSummary, encodePng, crc32, renderPng, ring, coordsIn,
  blockColor, summaryLine, snapshot, snapshotBox, changedColumns, savePicture, flatSpot, groundAt, findJava, walkFiles,
  TESTS, ORDER
}
