// Scouting like a player (!explore [radius]): a spiral of waypoints on the surface around the start, a short careful
// walk into caves it can see, and one chat line per notable find with its coordinates. It never digs.
//
// The same rule as mining: a block counts only when it has an open face and bot.canSeeBlock says so from where the
// bot stands (a capped number of checks per look), an animal or a villager only within 32 blocks with a clear line
// from the eye, and a cave entrance only when a line of sight from the eye runs into dark covered air below its
// feet. It never reads the whole loaded world, which would read as X-ray.
//
// Finds: villages (a bell, villagers, or 3 village blocks such as beds, composters, lecterns, hay bales and dirt
// paths), cave entrances, exposed ore (grouped), lava, water (sparingly) and animals for food (with a count). Each is
// said once per kind and area. The job keeps its progress, so a fight can pause it and it carries on after.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')

const DEFAULT_RADIUS = 64
const SEE = 32                 // how far it notices blocks from where it stands
const ENTITY_SEE = 32          // how far it notices animals and villagers
const LOS_CAP = { ore: 24, lava: 8, water: 6, village: 12 }  // line of sight checks per look and kind
const RAY_LEN = 24             // the cave entrance look
const DARK = 11                // sky light at or under this counts as dark
const CAVE_DEPTH = 16          // deepest it walks into a cave, below the start
const MAX_PEEKS = 2            // caves it walks into per trip
const MAX_FAILS = 6            // waypoints in a row it cannot reach before it heads back
const RING_MARGIN = 5          // the outer ring stays this far inside the radius (waypoints are reached within 3)
const LEG = 18                 // blocks between waypoints on a ring
const AREA = { village: 96, cave: 24, ore: 10, lava: 24, water: 64, animals: 32 }  // one report per kind and area
const MAX_REPORTS = { water: 3, lava: 5 }
const MIN_ANIMALS = 2

const ORE_KINDS = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']
const ORE_NAMES = ORE_KINDS.flatMap(k => [`${k}_ore`, `deepslate_${k}_ore`])
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan',
  'purple', 'blue', 'brown', 'green', 'red', 'black']
const VILLAGE_NAMES = ['composter', 'lectern', 'hay_block', 'dirt_path', 'smoker', 'blast_furnace', 'cartography_table',
  'fletching_table', 'grindstone', 'loom', 'smithing_table', 'stonecutter', 'brewing_stand', 'cauldron',
  ...COLORS.map(c => `${c}_bed`)]
const FOOD_ANIMALS = { cow: 'cows', pig: 'pigs', sheep: 'sheep', chicken: 'chickens', rabbit: 'rabbits' }
const AIR = new Set(['air', 'cave_air'])
const SEE_THROUGH = /glass|_leaves$|iron_bars|_fence$|_fence_gate$/

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fmt = p => `${Math.floor(p.x ?? p[0])} ${Math.floor(p.y ?? p[1])} ${Math.floor(p.z ?? p[2])}`
const vec = p => Array.isArray(p) ? new Vec3(p[0], p[1], p[2]) : new Vec3(p.x, p.y, p.z)

function oreKind (name) {
  const m = /^(?:deepslate_)?([a-z]+)_ore$/.exec(name)
  return m && ORE_KINDS.includes(m[1]) ? m[1] : null
}

function opaque (block) {
  return !!block && block.boundingBox === 'block' && !SEE_THROUGH.test(block.name)
}

// The cells a straight line from a to b passes through, in order (the Amanatides and Woo voxel walk)
function cellsOnLine (a, b) {
  const out = []
  let x = Math.floor(a.x)
  let y = Math.floor(a.y)
  let z = Math.floor(a.z)
  const end = [Math.floor(b.x), Math.floor(b.y), Math.floor(b.z)]
  const d = b.minus(a)
  const sx = Math.sign(d.x)
  const sy = Math.sign(d.y)
  const sz = Math.sign(d.z)
  const tdx = sx ? Math.abs(1 / d.x) : Infinity
  const tdy = sy ? Math.abs(1 / d.y) : Infinity
  const tdz = sz ? Math.abs(1 / d.z) : Infinity
  let tx = sx > 0 ? (x + 1 - a.x) / d.x : sx < 0 ? (a.x - x) / -d.x : Infinity
  let ty = sy > 0 ? (y + 1 - a.y) / d.y : sy < 0 ? (a.y - y) / -d.y : Infinity
  let tz = sz > 0 ? (z + 1 - a.z) / d.z : sz < 0 ? (a.z - z) / -d.z : Infinity
  out.push(new Vec3(x, y, z))
  for (let i = 0; i < 400; i++) {
    if (x === end[0] && y === end[1] && z === end[2]) break
    if (tx <= ty && tx <= tz) {
      if (tx > 1) break
      x += sx
      tx += tdx
    } else if (ty <= tz) {
      if (ty > 1) break
      y += sy
      ty += tdy
    } else {
      if (tz > 1) break
      z += sz
      tz += tdz
    }
    out.push(new Vec3(x, y, z))
  }
  return out
}

// Nothing solid between two points (the cells of both ends do not count)
function clearLine (bot, from, to) {
  const cells = cellsOnLine(from, to)
  for (let i = 1; i < cells.length - 1; i++) {
    const b = bot.blockAt(cells[i])
    if (!b || opaque(b)) return false
  }
  return true
}

function eyeOf (bot) {
  return bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
}

function openFace (bot, pos) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && b.boundingBox === 'empty') return true
  }
  return false
}

const idsOf = (bot, names) => names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)

// Blocks of these names it can see from here, nearest first, at most cap line of sight checks
function visibleBlocks (bot, names, cap) {
  const ids = idsOf(bot, names)
  if (!ids.length) return []
  const out = []
  let checks = 0
  for (const pos of bot.findBlocks({ matching: ids, maxDistance: SEE, count: 300 })) {
    if (checks >= cap) break
    if (!openFace(bot, pos)) continue
    const b = bot.blockAt(pos)
    if (!b) continue
    checks++
    if (bot.canSeeBlock(b)) out.push(b)
  }
  return out
}

// Waypoints on rings around the start, starting in the direction it faces. Every one lies inside the radius
function spiral (start, radius, yaw = 0) {
  const outer = Math.max(4, radius - RING_MARGIN)
  let rings = [...new Set([0.4, 0.75, 1].map(f => Math.round(outer * f)).filter(r => r >= 6))]
  if (!rings.length) rings = [outer]
  const a0 = Math.atan2(-Math.cos(yaw), -Math.sin(yaw))  // Mineflayer's yaw 0 looks at -z
  const out = []
  for (const r of rings) {
    const n = Math.max(6, Math.round(2 * Math.PI * r / LEG))
    for (let k = 0; k < n; k++) {
      const a = a0 + 2 * Math.PI * k / n
      out.push(new Vec3(Math.round(start.x + r * Math.cos(a)), Math.floor(start.y), Math.round(start.z + r * Math.sin(a))))
    }
  }
  return out
}

function setup (bot, job, capMs) {
  if (!Array.isArray(job.found)) job.found = []
  if (!job.stats) job.stats = { walked: 0, finds: 0, startedAt: Date.now(), endedAt: null, reached: 0, failed: 0, peeks: 0 }
  if (!job.ctx) {
    job.radius = job.radius || DEFAULT_RADIUS
    job.start = job.start ? vec(job.start) : bot.entity.position.clone()
    job.ctx = {
      phase: 'explore',
      waypoints: spiral(job.start, job.radius, bot.entity.yaw),
      index: 0,
      looked: false,
      trail: [],
      counted: new Set(),      // ids of animals already in a report
      villageHints: [],        // village blocks seen so far
      caves: [],               // cave entrances it may walk into
      peeked: new Set(),
      peeks: 0,
      reports: {},
      activeMs: 0,
      fails: 0,
      stop: null,
      capMs: capMs ?? clamp(job.radius * 5000, 90000, 600000)
    }
  }
  return job.ctx
}

function isNew (job, kind, label, pos, area) {
  const p = vec(pos)
  return !job.found.some(f => f.kind === kind && f.label === label && vec(f.pos).distanceTo(p) < area)
}

function report (job, hooks, kind, label, pos, count, text) {
  const p = vec(pos)
  const find = { kind, label, pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], count, text }
  job.found.push(find)
  job.stats.finds = job.found.length
  job.ctx.reports[kind] = (job.ctx.reports[kind] || 0) + 1
  hooks.log(`explore find: ${text}`)
  hooks.say(text, { key: `explore-${kind}-${job.found.length}`, find })
}

// Groups blocks lying within gap of each other
function groups (blocks, gap) {
  const out = []
  for (const b of blocks) {
    const g = out.find(list => list.some(o => o.position.distanceTo(b.position) <= gap))
    if (g) g.push(b)
    else out.push([b])
  }
  return out
}

function centre (positions) {
  const s = positions.reduce((a, p) => a.plus(p), new Vec3(0, 0, 0))
  return s.scaled(1 / positions.length)
}

// A line of sight from the eye that runs into dark covered air below its feet: the mouth of a cave it can see
function caveMouth (bot, eye, dir, feetY) {
  const cells = cellsOnLine(eye, eye.plus(dir.scaled(RAY_LEN)))
  for (let i = 1; i < cells.length; i++) {
    const c = cells[i]
    const b = bot.blockAt(c)
    if (!b || b.name === 'lava' || b.name === 'water' || opaque(b)) return null
    if (!AIR.has(b.name) || c.y > feetY - 1 || (b.skyLight ?? 15) > DARK) continue
    let room = 0
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = bot.blockAt(c.offset(dx, dy, dz))
      if (n && AIR.has(n.name)) room++
    }
    if (room < 2) continue
    let covered = false
    for (let up = 1; up <= 8 && !covered; up++) covered = opaque(bot.blockAt(c.offset(0, up, 0)))
    if (covered) return c
  }
  return null
}

function lavaNear (bot, pos, r = 4) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (bot.blockAt(pos.offset(dx, dy, dz))?.name === 'lava') return true
      }
    }
  }
  return false
}

// One look around from where it stands. Reports what is new and returns how many finds it made
function scan (bot, job, hooks) {
  const ctx = job.ctx
  const before = job.found.length
  const eye = eyeOf(bot)

  // exposed ore, grouped by kind
  const ores = visibleBlocks(bot, ORE_NAMES, LOS_CAP.ore)
  for (const kind of ORE_KINDS) {
    const mine = ores.filter(b => oreKind(b.name) === kind)
    for (const g of groups(mine, 4)) {
      const p = g[0].position
      if (!isNew(job, 'ore', kind, p, AREA.ore)) continue
      report(job, hooks, 'ore', kind, p, g.length, `Exposed ${kind} ore at ${fmt(p)}${g.length > 1 ? ` (${g.length} blocks)` : ''}`)
    }
  }

  // lava, a few reports a trip
  if ((ctx.reports.lava || 0) < MAX_REPORTS.lava) {
    for (const g of groups(visibleBlocks(bot, ['lava'], LOS_CAP.lava), 6)) {
      const p = g[0].position
      if ((ctx.reports.lava || 0) >= MAX_REPORTS.lava || !isNew(job, 'lava', 'lava', p, AREA.lava)) continue
      report(job, hooks, 'lava', 'lava', p, g.length, `Lava at ${fmt(p)}`)
    }
  }

  // water, sparingly: the first in each wide area
  const here = bot.entity.position
  const waterNear = job.found.some(f => f.kind === 'water' && vec(f.pos).distanceTo(here) < AREA.water)
  if ((ctx.reports.water || 0) < MAX_REPORTS.water && !waterNear) {
    const w = visibleBlocks(bot, ['water'], LOS_CAP.water)[0]
    if (w && isNew(job, 'water', 'water', w.position, AREA.water)) report(job, hooks, 'water', 'water', w.position, 1, `Water at ${fmt(w.position)}`)
  }

  // a village: a bell or a villager is enough, otherwise 3 village blocks close together
  const strong = []
  for (const b of visibleBlocks(bot, ['bell'], 4)) strong.push({ pos: b.position, why: 'a bell' })
  const animals = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e.isValid === false || !e.position) continue
    if (e.position.distanceTo(here) > ENTITY_SEE) continue
    const isVillager = e.name === 'villager'
    const isFood = !!FOOD_ANIMALS[e.name]
    if (!isVillager && !(isFood && !ctx.counted.has(e.id))) continue
    if (!clearLine(bot, eye, e.position.offset(0, (e.height || 1) * 0.6, 0))) continue
    if (isVillager) strong.push({ pos: e.position, why: 'villagers' })
    else animals.push(e)
  }
  for (const b of visibleBlocks(bot, VILLAGE_NAMES, LOS_CAP.village)) {
    if (!ctx.villageHints.some(p => p.equals(b.position))) ctx.villageHints.push(b.position.clone())
  }
  let village = strong[0] || null
  if (!village && ctx.villageHints.length >= 3) {
    const last = ctx.villageHints[ctx.villageHints.length - 1]
    const near = ctx.villageHints.filter(p => p.distanceTo(last) <= 48)
    if (near.length >= 3) village = { pos: centre(near), why: 'village blocks' }
  }
  if (village && isNew(job, 'village', 'village', village.pos, AREA.village)) {
    report(job, hooks, 'village', 'village', village.pos, 1, `Village at ${fmt(village.pos)} (${village.why})`)
  }

  // animals for food, counted once each
  if (animals.length >= MIN_ANIMALS) {
    const c = centre(animals.map(e => e.position))
    if (isNew(job, 'animals', 'animals', c, AREA.animals)) {
      const counts = {}
      for (const e of animals) counts[e.name] = (counts[e.name] || 0) + 1
      const what = Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${n} ${n === 1 ? name : FOOD_ANIMALS[name]}`).join(', ')
      report(job, hooks, 'animals', 'animals', c, animals.length, `Animals for food at ${fmt(c)}: ${what}`)
    }
    for (const e of animals) ctx.counted.add(e.id)
  }

  // cave entrances: a fan of looks down and around
  const feetY = Math.floor(here.y)
  for (let i = 0; i < 16; i++) {
    const yaw = i * Math.PI / 8
    for (const pitch of [-0.15, -0.35, -0.6, -0.9]) {
      const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      const mouth = caveMouth(bot, eye, dir, feetY)
      if (!mouth || !isNew(job, 'cave', 'cave', mouth, AREA.cave)) continue
      report(job, hooks, 'cave', 'cave', mouth, 1, `Cave entrance at ${fmt(mouth)}`)
      ctx.caves.push(mouth)
    }
  }
  return job.found.length - before
}

// A walk that adds to the distance walked even when it fails partway
async function walk (bot, job, goal, token, ms) {
  const from = bot.entity.position.clone()
  try {
    await goTo(bot, goal, token, ms)
  } finally {
    job.stats.walked += Math.round(from.distanceTo(bot.entity.position))
  }
}

const limitFor = d => clamp(Math.round(d * 1000), 15000, 60000)

// A copy of the walking rules that only steps down one block at a time, so it can always climb back out
function carefulMoves (moves) {
  if (!moves) return null
  const m = Object.assign(Object.create(Object.getPrototypeOf(moves)), moves)
  m.maxDropDown = 1
  m.allowParkour = false
  m.infiniteLiquidDropdownDistance = false
  return m
}

// The walking rules to use: the ones given, else a copy of the current ones that never digs
function noDig (bot, moves) {
  if (moves) return moves
  const cur = bot.pathfinder.movements
  if (!cur || !cur.canDig) return null
  const m = Object.assign(Object.create(Object.getPrototypeOf(cur)), cur)
  m.canDig = false
  return m
}

function nextCave (bot, job) {
  const ctx = job.ctx
  if (ctx.peeks >= MAX_PEEKS) return null
  for (const c of ctx.caves) {
    const k = c.toString()
    if (ctx.peeked.has(k)) continue
    ctx.peeked.add(k)
    if (c.y < job.start.y - CAVE_DEPTH) continue
    if (c.distanceTo(job.start) > job.radius) continue
    if (lavaNear(bot, c)) continue
    return c
  }
  return null
}

// Walks a little way into a cave it saw, looks around and carries on (the next waypoint walks it back out)
async function peek (bot, job, cave, token, hooks, moves) {
  job.ctx.peeks++
  job.stats.peeks++
  const careful = carefulMoves(moves)
  if (careful) bot.pathfinder.setMovements(careful)
  try {
    await walk(bot, job, new goals.GoalNear(cave.x, cave.y, cave.z, 2), token, 25000)
    if (token.cancelled) return
    job.ctx.trail.push(bot.entity.position.floored())
    hooks.log(`${bot.username} looks into the cave at ${fmt(cave)}`)
    scan(bot, job, hooks)
  } catch (err) {
    hooks.log(`${bot.username} could not walk into the cave at ${fmt(cave)}: ${err.message}`)
  } finally {
    if (moves) bot.pathfinder.setMovements(moves)
  }
}

// Back to the start: straight there, else through the spots it reached on the way out, nearest to the start first
async function comeBack (bot, job, token, hooks) {
  const start = job.start
  const near = () => bot.entity.position.distanceTo(start) <= 4
  const tried = new Set()
  for (let attempt = 0; attempt < 6 && !token.cancelled; attempt++) {
    if (near()) return true
    try {
      await walk(bot, job, new goals.GoalNear(start.x, start.y, start.z, 2), token, limitFor(bot.entity.position.distanceTo(start)))
    } catch (err) {
      hooks.log(`${bot.username} explore, way back: ${err.message}`)
    }
    if (token.cancelled || near()) break
    const here = bot.entity.position
    const left = job.ctx.trail.filter(p => !tried.has(p.toString()))
    let pick = left.filter(p => p.distanceTo(here) <= 32).sort((a, b) => a.distanceTo(start) - b.distanceTo(start))[0]
    if (!pick) pick = left.sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0]
    if (!pick) break
    tried.add(pick.toString())
    try {
      await walk(bot, job, new goals.GoalNear(pick.x, pick.y, pick.z, 2), token, limitFor(here.distanceTo(pick)))
    } catch (err) {
      hooks.log(`${bot.username} explore, way back by ${fmt(pick)}: ${err.message}`)
    }
  }
  return near()
}

function summary (bot, job, back) {
  const by = kind => job.found.filter(f => f.kind === kind)
  const parts = []
  const v = by('village')
  if (v.length) parts.push(`a village at ${fmt(v[0].pos)}${v.length > 1 ? ` and ${v.length - 1} more` : ''}`)
  const c = by('cave')
  if (c.length) parts.push(c.length === 1 ? `a cave entrance at ${fmt(c[0].pos)}` : `${c.length} cave entrances`)
  const o = by('ore')
  if (o.length) parts.push(`exposed ${[...new Set(o.map(f => f.label))].join(' and ')} ore`)
  const l = by('lava')
  if (l.length) parts.push(l.length === 1 ? 'lava in 1 spot' : `lava in ${l.length} spots`)
  if (by('water').length) parts.push('water')
  const n = by('animals').reduce((s, f) => s + f.count, 0)
  if (n) parts.push(`${n} animals for food`)
  const what = parts.length ? parts.join(', ') : 'nothing worth noting'
  let head = `Back from exploring ${job.radius} blocks`
  if (!back) head = `I couldn't find the way back, I am at ${fmt(bot.entity.position)}`
  else if (job.ctx.stop === 'stuck') head = 'Back early, I kept getting stuck'
  return `${head}: ${what}`.slice(0, 250)
}

// The job. job: { radius, start, found, stats }. Returns { result: 'done' | 'cancelled' | 'stuck', message }
async function exploreJob (bot, job, human, token, { say = () => {}, log = () => {}, moves = null, now = Date.now, capMs } = {}) {
  const ctx = setup(bot, job, capMs)
  const hooks = { say, log }
  if (ctx.phase === 'done') return { result: ctx.result, message: ctx.message }
  moves = noDig(bot, moves)
  if (moves) bot.pathfinder.setMovements(moves)
  let last = now()
  const tick = () => {
    const t = now()
    ctx.activeMs += t - last
    last = t
  }

  if (ctx.phase === 'explore' && !ctx.looked) {
    scan(bot, job, hooks)
    ctx.looked = true
  }
  while (ctx.phase === 'explore' && !token.cancelled) {
    tick()
    if (ctx.activeMs >= ctx.capMs) { ctx.stop = 'time'; break }
    if (ctx.fails >= MAX_FAILS) { ctx.stop = 'stuck'; break }
    const cave = nextCave(bot, job)
    if (cave) {
      await peek(bot, job, cave, token, hooks, moves)
      continue
    }
    if (ctx.index >= ctx.waypoints.length) break
    const wp = ctx.waypoints[ctx.index]
    try {
      await walk(bot, job, new goals.GoalNearXZ(wp.x, wp.z, 3), token, limitFor(bot.entity.position.distanceTo(wp)))
    } catch (err) {
      if (token.cancelled) break
      ctx.fails++
      job.stats.failed++
      ctx.index++
      log(`${bot.username} explore: gave up on the waypoint at ${wp.x} ${wp.z}: ${err.message}`)
      continue
    }
    if (token.cancelled) break
    ctx.fails = 0
    ctx.index++
    job.stats.reached++
    ctx.trail.push(bot.entity.position.floored())
    scan(bot, job, hooks)
    await human?.idleMoment?.(token)
  }
  if (token.cancelled) return { result: 'cancelled' }

  ctx.phase = 'return'
  const back = await comeBack(bot, job, token, hooks)
  if (token.cancelled) return { result: 'cancelled' }
  ctx.phase = 'done'
  job.stats.endedAt = Date.now()
  job.stats.finds = job.found.length
  ctx.result = back && ctx.stop !== 'stuck' ? 'done' : 'stuck'
  ctx.message = summary(bot, job, back)
  return { result: ctx.result, message: ctx.message }
}

module.exports = { exploreJob, scan, spiral, cellsOnLine, clearLine, caveMouth, oreKind, DEFAULT_RADIUS }
