// Building from a blueprint (skills/blueprint.js) the way a player would.
//
// 1. The site: every cell of the footprint is checked first. Only natural blocks get cleared (grass, dirt, stone,
//    sand, gravel, flowers, natural leaves, logs of natural trees). Anything a player could have placed (planks,
//    glass, chests, beds, farmland, crops, logs without natural leaves) stops the job with a short chat line, so a
//    bot never wrecks one of his builds. A cell that already holds the right block is left alone, so a build can be
//    finished later or run again safely.
// 2. Materials: what the cells still need, from its bag first, then the chests near the site. It says what is
//    missing, gathers the simple raw ones itself (logs, cobblestone, dirt, sand, coal, seeds), crafts the simple
//    ones (planks, sticks, slabs, doors, torches, chests, a hoe, a composter) on a crafting table it places and picks
//    back up, and gives up with the exact list when something is out of its reach (a bed, a water bucket).
// 3. Clearing, top down. 4. Placing layer by layer like a player: bottom up, outside in, a block with something to
//    rest on before an overhang, a dirt scaffold under a block with nothing next to it (removed after), blocks with a
//    facing placed while looking the right way, then the things that hang on others (doors, beds, torches, crops).
// The job keeps its progress, so a fight or a meal can pause it and it carries on after.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')
const { pickTool } = require('./mine')
const bp = require('./blueprint')
const { planItems, craftAll, pickUpTable, INTERACTIVE } = require('./craft')
const { gather, isNaturalLog, isNaturalLeaves, fillBuckets, count } = require('./gather')
const { countItems, fetchFrom } = require('./storage')

const REACH = 4.2
const YAW = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' }
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const NATURAL = new Set([
  'air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'bush', 'firefly_bush',
  'short_dry_grass', 'tall_dry_grass', 'sweet_berry_bush', 'grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt',
  'mycelium', 'mud', 'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'sand', 'red_sand',
  'gravel', 'clay', 'snow', 'moss_carpet', 'pale_moss_carpet', 'vine', 'glow_lichen', 'brown_mushroom', 'red_mushroom',
  'pink_petals', 'wildflowers', 'leaf_litter', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac',
  'rose_bush', 'peony', 'open_eyeblossom', 'closed_eyeblossom', 'cactus_flower', 'hanging_roots'
])
const SCAFFOLD = ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate']
const ATTACHED = new Set(['door', 'bed', 'torch', 'wall_torch', 'ladder', 'lantern', 'carpet', 'crop', 'sapling'])
const kkey = p => `${p.x},${p.y},${p.z}`

class Refused extends Error {}

// What is in a cell now: air, natural (fine to clear), liquid, ours (its own scaffold) or placed (could be his)
function classify (bot, block, job) {
  if (!block) return 'unknown'
  if (job?.scaffolds?.some(s => s.x === block.position.x && s.y === block.position.y && s.z === block.position.z)) return 'ours'
  if (bp.AIRS.has(block.name)) return 'air'
  if (block.name === 'water' || block.name === 'lava') return 'liquid'
  if (NATURAL.has(block.name) || /_ore$/.test(block.name)) return 'natural'
  if (/_leaves$/.test(block.name)) return isNaturalLeaves(block) ? 'natural' : 'placed'
  if (/_log$/.test(block.name)) return isNaturalLog(bot, block.position) ? 'natural' : 'placed'
  return 'placed'
}

// The cell already holds what the blueprint wants
function cellDone (bot, cell) {
  const b = bot.blockAt(cell.pos)
  if (!b) return false
  if (cell.kind === 'air') return bp.AIRS.has(b.name)
  if (cell.name === 'dirt') return bp.DIRT_LIKE.has(b.name)
  if (cell.kind === 'water') return b.name === 'water' && Number(b.getProperties().level) === 0
  if (cell.kind === 'slab') return b.name === cell.name && (!cell.props.type || b.getProperties().type === cell.props.type)
  return b.name === cell.name
}

// Placed with the facing, half, type and axis the blueprint asked for
function placedRight (bot, cell) {
  const b = bot.blockAt(cell.pos)
  if (!b || b.name !== cell.name) return { ok: false, why: `${b?.name ?? 'nothing'} instead of ${cell.name}` }
  const got = b.getProperties()
  for (const k of ['facing', 'half', 'type', 'axis', 'part', 'hanging']) {
    if (!(k in cell.props) || bp.FREE_PROPS.has(k)) continue
    if (k === 'type' && /chest$/.test(cell.name)) continue
    if (String(got[k]) !== String(cell.props[k])) return { ok: false, why: `${k} ${got[k]} instead of ${cell.props[k]}` }
  }
  return { ok: true }
}

// A standing spot whose eye is within range of a point, clear of the cells it must not stand in. Outside the
// footprint first, then anywhere
class GoalReach extends goals.Goal {
  constructor (point, { range = REACH, avoid = [], box = null, inside = true } = {}) {
    super()
    this.point = point
    this.x = Math.floor(point.x)
    this.y = Math.floor(point.y)
    this.z = Math.floor(point.z)
    this.range = range
    this.avoid = avoid
    this.box = box
    this.inside = inside
  }

  heuristic (node) {
    const dx = node.x + 0.5 - this.point.x
    const dz = node.z + 0.5 - this.point.z
    return Math.max(0, Math.hypot(dx, dz) - this.range + 1) + Math.abs(node.y + 1.62 - this.point.y) * 0.5
  }

  isEnd (node) {
    const eye = new Vec3(node.x + 0.5, node.y + 1.62, node.z + 0.5)
    if (eye.distanceTo(this.point) > this.range) return false
    for (const a of this.avoid) if (a.x === node.x && a.z === node.z && (a.y === node.y || a.y === node.y + 1)) return false
    if (!this.inside && this.box && inBox(node, this.box, 0)) return false
    return true
  }

  hasChanged () { return false }
  isValid () { return true }
}

function inBox (p, box, pad = 0) {
  return p.x >= box.min.x - pad && p.x <= box.max.x + pad && p.z >= box.min.z - pad && p.z <= box.max.z + pad &&
    p.y >= box.min.y - pad - 1 && p.y <= box.max.y + pad
}

// The same test as GoalReach.isEnd, from the middle of the block it stands on. With its real eye instead, the
// pathfinder called a spot reached that this test refused, so the face of the block below a log was given up for a
// side face and 6 border logs came out lying down (axis x) in one live test. The server allows more reach
function standsOK (bot, point, range, avoid) {
  const f = bot.entity.position.floored()
  if (new Vec3(f.x + 0.5, f.y + 1.62, f.z + 0.5).distanceTo(point) > range) return false
  return !avoid.some(a => a.x === f.x && a.z === f.z && (a.y === f.y || a.y === f.y + 1))
}

// Gets the bot's eye within range of point without standing in the avoid cells. In one live test the
// pathfinder never got the bot out of a one block deep trench (the jump up never happened), so a failed walk is
// followed by a jump out by hand and one more try
async function standFor (bot, point, job, token, avoid = [], range = REACH) {
  if (standsOK(bot, point, range, avoid)) return true
  let last = null
  for (const inside of [false, true]) {
    if (token?.cancelled) return false
    try {
      await goTo(bot, new GoalReach(point, { range, avoid, box: job.box, inside }), token, inside ? 15000 : 8000)
      job.stats.walks++
      if (standsOK(bot, point, range, avoid)) return true
    } catch (err) {
      last = err
      if (await climbOut(bot, token)) {
        job.stats.climbs = (job.stats.climbs || 0) + 1
        try {
          await goTo(bot, new GoalReach(point, { range, avoid, box: job.box, inside }), token, 15000)
          if (standsOK(bot, point, range, avoid)) return true
        } catch (err2) {
          last = err2
        }
      }
    }
  }
  if (last) job.hooks.log?.(`${bot.username} could not get near ${point.floored()}: ${last.message}`)
  return standsOK(bot, point, range, avoid)
}

// Blocks with a hollow top the bot falls into and the pathfinder takes for full blocks (one live test ended
// with the bot inside the farm's composter for 13 minutes)
const HOLLOW = /^(composter|cauldron|water_cauldron|lava_cauldron|powder_snow_cauldron|hopper)$/

// In a hole one block deep, or inside a hollow block: jump onto a neighbour with room above it. Returns true when
// it got out
async function climbOut (bot, token) {
  const feet = bot.entity.position.floored()
  const free = p => bot.blockAt(p)?.boundingBox === 'empty' && !['water', 'lava'].includes(bot.blockAt(p)?.name)
  const inHollow = HOLLOW.test(bot.blockAt(feet)?.name || '')
  const steps = SIDES.map(([dx, dz]) => feet.offset(dx, 0, dz))
    .filter(p => inHollow
      ? free(p) && free(p.offset(0, 1, 0)) && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
      : solidAt(bot, p) && free(p.offset(0, 1, 0)) && free(p.offset(0, 2, 0)))
    .map(p => inHollow ? p.offset(0, -1, 0) : p)
  if (!steps.length || !free(feet.offset(0, inHollow ? 1 : 2, 0))) return false
  const to = steps[0]
  const y0 = inHollow ? bot.entity.position.y - 1 : bot.entity.position.y
  bot.pathfinder.setGoal(null)
  try {
    await bot.look(Math.atan2(-(to.x + 0.5 - bot.entity.position.x), -(to.z + 0.5 - bot.entity.position.z)), 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    for (let t = 0; t < 14 && !token?.cancelled; t++) {
      await bot.waitForTicks(1)
      if (bot.entity.position.y >= y0 + 0.9 && bot.entity.onGround) break
    }
  } finally {
    bot.setControlState('jump', false)
    bot.setControlState('forward', false)
  }
  await bot.waitForTicks(4)
  if (inHollow) return !HOLLOW.test(bot.blockAt(bot.entity.position.floored())?.name || '')
  return bot.entity.position.y >= y0 + 0.9
}

// Cells the job has dug and not filled yet (a floor cell before its block) and the water channel are kept out of
// the pathfinder's walks, so it never steps down into a trench or a channel it cannot jump out of
function guardHoles (bot, job) {
  job.holes = job.holes || new Set()
  if (job.blueprint && job.anchor) for (const k of hollowTops(plan(bot, job))) job.holes.add(k)
  guardCells(bot, job.holes)
}

// The cells above hollow blocks of a plan, kept out of walks so the bot never stands on (and falls into) them
function hollowTops (cells) {
  return cells.filter(c => HOLLOW.test(c.name)).map(c => kkey(c.pos.offset(0, 1, 0)))
}

function guardCells (bot, keys) {
  bot._crewHoles = keys
  const m = bot.pathfinder?.movements
  if (m && Array.isArray(m.exclusionAreasStep) && !m._crewHoleGuard) {
    m._crewHoleGuard = true
    m.exclusionAreasStep.push(block => (bot._crewHoles && block?.position && bot._crewHoles.has(kkey(block.position))) ? 100 : 0)
  }
}

const solidAt = (bot, p) => {
  const b = bot.blockAt(p)
  return !!b && b.boundingBox === 'block' && !INTERACTIVE.test(b.name)
}

// The faces it could click to put this cell's block in, best first: { ref, face, half }
function refsFor (bot, cell) {
  const p = cell.pos
  const below = { ref: p.offset(0, -1, 0), face: new Vec3(0, 1, 0) }
  const above = { ref: p.offset(0, 1, 0), face: new Vec3(0, -1, 0) }
  const sides = SIDES.map(([dx, dz]) => ({ ref: p.offset(dx, 0, dz), face: new Vec3(-dx, 0, -dz) }))
  const props = cell.props || {}
  let list
  switch (cell.kind) {
    case 'door': case 'bed': case 'torch': case 'carpet':
      list = [below]
      break
    case 'crop': {
      const f = bot.blockAt(below.ref)
      return f && f.name === 'farmland' ? [below] : []
    }
    case 'sapling': {
      const f = bot.blockAt(below.ref)
      return f && bp.DIRT_LIKE.has(f.name) ? [below] : []
    }
    case 'wall_torch': case 'ladder': {
      const [dx, dz] = bp.STEP[props.facing] || [0, 1]
      list = [{ ref: p.offset(-dx, 0, -dz), face: new Vec3(dx, 0, dz) }]
      break
    }
    case 'lantern':
      list = String(props.hanging) === 'true' ? [above] : [below]
      break
    case 'axis': {
      const a = props.axis || 'y'
      const along = r => (a === 'y' && r.face.y !== 0) || (a === 'x' && r.face.x !== 0) || (a === 'z' && r.face.z !== 0)
      list = [below, above, ...sides].sort((r1, r2) => along(r2) - along(r1))
      break
    }
    case 'slab': case 'stairs': {
      const top = props.type === 'top' || props.half === 'top'
      list = top ? [above, ...sides.map(s => ({ ...s, half: 'top' }))] : [below, ...sides.map(s => ({ ...s, half: 'bottom' }))]
      break
    }
    default:
      list = [below, ...sides, above]
  }
  return list.filter(r => solidAt(bot, r.ref))
}

// The cells a block in this cell will fill or needs free (a door's upper half, a bed's head)
function occupied (cell) {
  const out = [cell.pos]
  if (cell.kind === 'door') out.push(cell.pos.offset(0, 1, 0))
  if (cell.kind === 'bed') {
    const [dx, dz] = bp.STEP[cell.props.facing] || [0, 1]
    out.push(cell.pos.offset(dx, 0, dz))
  }
  return out
}

function lookYaw (cell) {
  const f = cell.props?.facing
  if (!YAW.hasOwnProperty(f)) return null
  if (['door', 'bed', 'stairs', 'facing_look'].includes(cell.kind)) return YAW[f]
  if (cell.kind === 'facing_away') return YAW[OPPOSITE[f]]
  return null
}

async function equipItem (bot, name) {
  const item = bot.inventory.items().find(i => i.name === name)
  if (!item) return false
  if (bot.heldItem?.type !== item.type) await bot.equip(item, 'hand')
  return true
}

// Puts one cell's block in. Returns 'placed', 'later' (nothing to rest it on yet, or in the way) or 'missing'.
// A natural block in the cell (grass where a log goes) is dug right before, so the ground is never left open
async function placeCell (bot, cell, job, token) {
  const item = cell.item
  if (!item) return 'placed'
  if (!bot.inventory.items().some(i => i.name === item)) return 'missing'
  const here = bot.blockAt(cell.pos)
  if (here && !bp.AIRS.has(here.name) && here.name !== cell.name && here.name !== 'water') {
    if (!await clearCell(bot, cell.pos, job, token)) return 'later'
    job.holes?.add(kkey(cell.pos))
  }
  const refs = refsFor(bot, cell)
  if (!refs.length) return 'later'
  const avoid = occupied(cell)
  // the free cells a door or a bed needs
  for (const p of avoid.slice(1)) if (!bp.AIRS.has(bot.blockAt(p)?.name)) return 'later'
  let r = null
  for (const cand of refs) {
    const point = cand.ref.offset(0.5 + cand.face.x * 0.5, 0.5 + cand.face.y * 0.5, 0.5 + cand.face.z * 0.5)
    if (await standFor(bot, point, job, token, avoid)) { r = cand; break }
    if (token?.cancelled) return 'later'
  }
  if (!r) return 'later'
  await equipItem(bot, item)
  const yaw = lookYaw(cell)
  const refBlock = bot.blockAt(r.ref)
  try {
    if (yaw !== null) {
      await bot.look(yaw, 0.6, true)
      await bot.waitForTicks(2)  // the look reaches the server before the click
      await bot._placeBlockWithOptions(refBlock, r.face, { forceLook: 'ignore', half: r.half, swingArm: 'right' })
    } else {
      await bot._placeBlockWithOptions(refBlock, r.face, { forceLook: true, half: r.half, swingArm: 'right' })
    }
  } catch (err) {
    job.hooks.log?.(`${bot.username} place ${cell.name} at ${cell.pos}: ${err.message}`)
    return 'later'
  }
  job.stats.placed++
  job.holes?.delete(kkey(cell.pos))
  const check = placedRight(bot, cell)
  if (!check.ok) {
    job.stats.wrongState++
    job.hooks.log?.(`${bot.username} placed ${cell.name} at ${cell.pos} with ${check.why}`)
  }
  return 'placed'
}

// Digs a natural block out of a cell (again when gravel or sand falls in)
async function clearCell (bot, pos, job, token) {
  for (let i = 0; i < 6 && !token?.cancelled; i++) {
    const b = bot.blockAt(pos)
    if (!b || bp.AIRS.has(b.name)) return true
    const cls = classify(bot, b, job)
    if (cls === 'liquid') return false
    if (cls === 'placed') throw new Refused(`${b.name.replace(/_/g, ' ')} at ${pos.x} ${pos.y} ${pos.z} could be yours`)
    const point = pos.offset(0.5, 0.5, 0.5)
    if (!await standFor(bot, point, job, token, [pos])) return false
    const pick = pickTool(bot, b)
    if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
    await bot.dig(b, true)
    job.stats.dug++
    await sleep(60)
  }
  return bp.AIRS.has(bot.blockAt(pos)?.name)
}

// A dirt column under a block that has nothing to rest on. Kept under layer 0 (it fills a dip), removed above
async function scaffoldUnder (bot, cell, job, token) {
  const column = []
  let p = cell.pos.offset(0, -1, 0)
  for (let i = 0; i < 8; i++) {
    const b = bot.blockAt(p)
    if (!b) return false
    if (b.boundingBox === 'block') break
    if (!bp.AIRS.has(b.name)) return false
    column.push(p)
    p = p.offset(0, -1, 0)
  }
  if (column.length >= 8) return false
  for (const q of column.reverse()) {
    const name = SCAFFOLD.find(n => count(bot, n) > 0)
    if (!name) return false
    const r = await placeCell(bot, { pos: q, name, item: name, kind: 'solid', props: {} }, job, token)
    if (r !== 'placed') return false
    job.stats.placed--
    job.stats.scaffolds++
    if (q.y >= job.anchor.y) job.scaffolds.push(q)
  }
  return true
}

async function till (bot, cell, job, token) {
  const b = bot.blockAt(cell.pos)
  if (!b) return 'later'
  if (b.name === 'farmland') return 'placed'
  if (!['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt'].includes(b.name)) {
    if (!bp.AIRS.has(b.name)) return 'later'
    if (count(bot, 'dirt') <= 0) return 'missing'
    const r = await placeCell(bot, { pos: cell.pos, name: 'dirt', item: 'dirt', kind: 'solid', props: {} }, job, token)
    if (r !== 'placed') return r
  }
  if (!bp.AIRS.has(bot.blockAt(cell.pos.offset(0, 1, 0))?.name)) {
    if (!await clearCell(bot, cell.pos.offset(0, 1, 0), job, token)) return 'later'
  }
  const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name))
  if (!hoe) return 'missing'
  if (!await standFor(bot, cell.pos.offset(0.5, 1, 0.5), job, token, [cell.pos])) return 'later'
  await bot.equip(hoe, 'hand')
  // twice for coarse dirt (it turns to dirt first)
  for (let i = 0; i < 2 && bot.blockAt(cell.pos)?.name !== 'farmland'; i++) {
    await bot.activateBlock(bot.blockAt(cell.pos))
    await bot.waitForTicks(2)
  }
  if (bot.blockAt(cell.pos)?.name !== 'farmland') return 'later'
  job.stats.tilled++
  return 'placed'
}

// A clear line from the eye to a point (no full block in between, farmland counts)
function clearLine (bot, eye, point, skip = null) {
  const d = point.minus(eye)
  const len = d.norm()
  for (let t = 0.3; t < len - 0.15; t += 0.1) {
    const p = eye.plus(d.scaled(t / len)).floored()
    if (skip && p.equals(skip)) continue
    const b = bot.blockAt(p)
    if (b && b.boundingBox === 'block') return false
  }
  return true
}

const standable = (bot, p) => {
  const free = q => bot.blockAt(q)?.boundingBox === 'empty' && !['water', 'lava'].includes(bot.blockAt(q)?.name)
  return free(p) && free(p.offset(0, 1, 0)) && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block'
}

// Water from a bucket into one open cell: it stands on a block right beside the cell and looks down at the cell's
// floor, and never pours without a clear line. In one live test it poured from 2 blocks away, the bucket's
// ray hit the farmland in between and the water ran over the farm, so no crop could go in
async function pourAt (bot, cell, job, token) {
  const point = cell.pos.offset(0.5, 0.05, 0.5)
  // an open cell, or one with flowing water from the first source (a bucket turns it into a source)
  const now = bot.blockAt(cell.pos)
  if (!now || !(bp.AIRS.has(now.name) || (now.name === 'water' && Number(now.getProperties().level) > 0))) return false
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const ready = () => eye().distanceTo(point) <= 4.0 && clearLine(bot, eye(), point)
  if (!ready()) {
    const spots = SIDES.map(([dx, dz]) => cell.pos.offset(dx, 1, dz))
      .filter(p => standable(bot, p) && !job.holes?.has(kkey(p.offset(0, -1, 0))))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    for (const s of spots) {
      if (token?.cancelled) return false
      try {
        await goTo(bot, new goals.GoalBlock(s.x, s.y, s.z), token, 10000)
      } catch {
        if (await climbOut(bot, token)) {
          try { await goTo(bot, new goals.GoalBlock(s.x, s.y, s.z), token, 10000) } catch {}
        }
      }
      if (ready()) break
    }
  }
  if (!ready()) return false
  if (!await equipItem(bot, 'water_bucket')) return false
  await bot.lookAt(point, true)
  await bot.waitForTicks(2)
  bot.activateItem()
  await bot.waitForTicks(8)
  // a source (level 0) in the cell: flowing water from an earlier spill is not a pour, and counting it as one skipped
  // the scoop of that spill (FIND-034 point 3)
  const poured = bot.blockAt(cell.pos)
  return poured?.name === 'water' && Number(poured.getProperties().level) === 0
}

// Water sources the job did not want, in or just above the footprint (a pour that missed): scooped back up
async function scoopSpills (bot, cells, job, token) {
  const want = new Set(cells.map(c => kkey(c.pos)))
  const box = job.box
  let n = 0
  for (let y = box.min.y; y <= box.max.y + 1; y++) {
    for (let x = box.min.x - 1; x <= box.max.x + 1; x++) {
      for (let z = box.min.z - 1; z <= box.max.z + 1; z++) {
        if (token?.cancelled || count(bot, 'bucket') <= 0) return n
        const p = new Vec3(x, y, z)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'water' || Number(b.getProperties().level) !== 0 || want.has(kkey(p))) continue
        if (await scoop(bot, p, job, token)) { n++; job.hooks.log?.(`${bot.username} scooped up spilled water at ${p}`) }
      }
    }
  }
  return n
}

async function scoop (bot, pos, job, token) {
  const point = pos.offset(0.5, 0.5, 0.5)
  if (!await standFor(bot, point, job, token, [pos], 4.0)) return false
  if (!await equipItem(bot, 'bucket')) return false
  const before = count(bot, 'water_bucket')
  await bot.lookAt(point, true)
  await bot.waitForTicks(2)
  bot.activateItem()
  await bot.waitForTicks(6)
  return count(bot, 'water_bucket') > before
}

// Fills the water cells. Two sources with one gap make a third, and a source between two others comes back after
// a bucket takes it, so two buckets fill any channel
async function fillWater (bot, cells, job, token) {
  const isSource = c => cellDone(bot, c)
  const neighbours = c => cells.filter(o => o !== c && Math.abs(o.pos.x - c.pos.x) + Math.abs(o.pos.z - c.pos.z) === 1 && o.pos.y === c.pos.y)
  for (let guard = 0; guard < 60 && !token?.cancelled; guard++) {
    const todo = cells.filter(c => !isSource(c))
    if (!todo.length) return 0
    if (count(bot, 'water_bucket') > 0) {
      const sources = cells.filter(isSource)
      const gap = todo.find(c => sources.some(s => {
        const d = Math.abs(s.pos.x - c.pos.x) + Math.abs(s.pos.z - c.pos.z)
        if (d !== 2 || s.pos.y !== c.pos.y) return false
        const mid = new Vec3((s.pos.x + c.pos.x) / 2, c.pos.y, (s.pos.z + c.pos.z) / 2)
        return todo.some(t => t.pos.equals(mid))
      }))
      const lone = todo.find(c => !neighbours(c).some(isSource))
      const target = gap || lone || todo[0]
      if (!(await pourAt(bot, target, job, token))) {
        job.hooks.log?.(`${bot.username} could not pour water at ${target.pos}`)
        job.waterMisses = (job.waterMisses || 0) + 1
        await bot.waitForTicks(10)
        await scoopSpills(bot, cells, job, token)
        if (job.waterMisses > 6) break
      } else job.stats.water++
      await bot.waitForTicks(10)
      continue
    }
    if (count(bot, 'bucket') > 0) {
      const refill = cells.filter(isSource).find(c => neighbours(c).filter(isSource).length >= 2)
      if (refill && await scoop(bot, refill.pos, job, token)) { await bot.waitForTicks(10); continue }
      if (await fillBuckets(bot, 1, token, { avoid: p => inBox(p, job.box, 1) })) continue
    }
    break
  }
  return cells.filter(c => !isSource(c)).length
}

// Orders a layer outside in: farthest from the middle first, then around
function outsideIn (cells, box) {
  const cx = (box.min.x + box.max.x) / 2
  const cz = (box.min.z + box.max.z) / 2
  return cells.slice().sort((a, b) => {
    const da = Math.max(Math.abs(a.pos.x - cx), Math.abs(a.pos.z - cz))
    const db = Math.max(Math.abs(b.pos.x - cx), Math.abs(b.pos.z - cz))
    if (da !== db) return db - da
    return Math.atan2(a.pos.z - cz, a.pos.x - cx) - Math.atan2(b.pos.z - cz, b.pos.x - cx)
  })
}

// Every cell, planned for this job's anchor and facing
function plan (bot, job) {
  if (!job.cells) {
    job.cells = bp.planCells(job.blueprint, job.anchor, job.facing, bot.registry)
    job.box = bp.footprint(job.cells)
  }
  return job.cells
}

// The site check: refuses when a cell holds a block he could have placed. Returns the cells still to do
function checkSite (bot, job) {
  const todo = []
  for (const c of plan(bot, job)) {
    const b = bot.blockAt(c.pos)
    if (!b) throw new Refused(`I can't see the whole site yet, come closer to ${job.anchor.x} ${job.anchor.y} ${job.anchor.z}`)
    if (cellDone(bot, c)) continue
    const cls = classify(bot, b, job)
    if (cls === 'placed') {
      // a crop of the wrong kind or farmland where farmland goes is his farm, still refused
      throw new Refused(`I won't build there: ${b.name.replace(/_/g, ' ')} at ${c.pos.x} ${c.pos.y} ${c.pos.z} could be yours`)
    }
    if (cls === 'liquid' && !(c.kind === 'water' && b.name === 'water')) {
      throw new Refused(`There is ${b.name} in the way at ${c.pos.x} ${c.pos.y} ${c.pos.z}`)
    }
    todo.push(c)
  }
  return todo
}

// What the remaining cells take, name to count, plus a hoe for farmland
function needs (bot, todo) {
  const cells = todo.map(c => ({ ...c, needsDirt: c.kind === 'farmland' && !['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt'].includes(bot.blockAt(c.pos)?.name) }))
  const m = bp.materialsFor(cells)
  const items = m.items
  if (m.tools.includes('hoe') && !bot.inventory.items().some(i => /_hoe$/.test(i.name))) items.set('wooden_hoe', 1)
  return { items, water: m.water }
}

function short (wants, have) {
  const out = new Map()
  for (const [k, n] of wants) {
    const s = n - (have.get(k) || 0)
    if (s > 0) out.set(k, s)
  }
  return out
}

// Gets every item the remaining cells take. Returns null when it has them all, else a chat line with what is missing
async function getMaterials (bot, job, todo, token) {
  const { say, log } = job.hooks
  const { items } = needs(bot, todo)
  let missing = short(items, countItems(bot))
  if (!missing.size) return null
  // the chests near the site and near the bot
  const got = await fetchFrom(bot, job.anchor, missing, token, 16)
  if (got.size) log?.(`${bot.username} took ${bp.describeItems(got)} from chests`)
  missing = short(items, countItems(bot))
  if (!missing.size) return null
  // water: empty buckets and water it can see
  const water = missing.get('water_bucket') || 0
  if (water && count(bot, 'bucket') > 0) {
    await fillBuckets(bot, water, token, { avoid: p => inBox(p, job.box, 1) })
    missing = short(items, countItems(bot))
  }
  // crops can start with the seeds it has, the harvest fills the rest
  const seedsShort = new Map()
  for (const k of ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']) {
    if (missing.has(k)) { seedsShort.set(k, missing.get(k)); missing.delete(k) }
  }
  const tableId = bot.registry.blocksByName.crafting_table.id
  const tableNear = bot.findBlocks({ matching: tableId, maxDistance: 6, count: 1 }).length > 0
  const p = planItems(bot.registry, missing, countItems(bot), { prefer: job.wood || 'oak', tableNear })
  if (p.missing.size) {
    return `For ${job.blueprint.name} I still need ${bp.describeItems(p.missing)}. Give me those or put them in a chest near the site`
  }
  if (p.gather.size) {
    say?.(`Getting ${bp.describeItems(p.gather)} first`)
    for (const [name, n] of p.gather) {
      if (token?.cancelled) return null
      const gotN = await gather(bot, name, n, token, { log, say, avoid: q => protectedSpot(job, q), mine: job.hooks.mine })
      job.stats.gathered += gotN
      if (gotN < n) return `I could only get ${gotN} of ${n} ${name} for ${job.blueprint.name}`
    }
  }
  if (p.crafts.length) {
    say?.(`Crafting ${p.crafts.map(c => c.name).join(', ')}`)
    job.stats.crafted += await craftAll(bot, p.crafts, job, token, { avoid: q => inBox(q, job.box, 1), log })
    if (!token?.cancelled) await pickUpTable(bot, job, token)
  }
  // seeds from grass it can see, as many as it finds quickly
  for (const [k, n] of seedsShort) {
    if (k !== 'wheat_seeds' || token?.cancelled) continue
    const gotN = await gather(bot, 'wheat_seeds', n, token, { log, avoid: q => protectedSpot(job, q) })
    if (gotN < n) say?.(`I have seeds for ${count(bot, 'wheat_seeds')} of the ${items.get('wheat_seeds')} spots, the harvest fills the rest`)
  }
  return null
}

// Never gather from a build the crew knows about (the site's own natural blocks are cleared by the job itself)
function protectedSpot (job, pos) {
  for (const b of job.hooks.builds?.() || []) if (b.box && inBox(pos, b.box, 1)) return true
  return false
}

// The cells to clear up front: natural blocks where air goes, top down. A cell that gets a block is dug right before
// its block goes in (placeCell), a water cell right before its water (fillWater), so no trench is left open
function toClear (bot, todo) {
  return todo.filter(c => {
    const b = bot.blockAt(c.pos)
    if (!b || bp.AIRS.has(b.name)) return false
    return c.kind === 'air'
  }).sort((a, b) => b.pos.y - a.pos.y)
}

async function placeLayers (bot, job, token) {
  const cells = plan(bot, job)
  const layers = [...new Set(cells.map(c => c.pos.y))].sort((a, b) => a - b)
  let missing = new Set()
  for (const y of layers) {
    if (token?.cancelled) return missing
    const layer = cells.filter(c => c.pos.y === y && c.kind !== 'air' && !cellDone(bot, c))
    // solid blocks first, outside in, a block with something to rest on before one without
    let solids = outsideIn(layer.filter(c => !ATTACHED.has(c.kind) && c.kind !== 'water' && c.kind !== 'farmland'), job.box)
    for (let pass = 0; pass < 4 && solids.length && !token?.cancelled; pass++) {
      const later = []
      for (const c of solids) {
        if (token?.cancelled) return missing
        if (cellDone(bot, c)) continue
        const r = await placeCell(bot, c, job, token)
        if (r === 'missing') missing.add(c.item)
        else if (r === 'later') later.push(c)
      }
      if (later.length === solids.length && pass >= 1) {
        // nothing next to them: a scaffold under each, then try again
        for (const c of later) await scaffoldUnder(bot, c, job, token)
      }
      solids = later
    }
    for (const c of solids) job.hooks.log?.(`${bot.username} could not place ${c.name} at ${c.pos}`)
    job.stats.skipped += solids.length
    for (const c of outsideIn(layer.filter(c => c.kind === 'farmland'), job.box)) {
      if (token?.cancelled) return missing
      const r = await till(bot, c, job, token)
      if (r === 'missing') missing.add(count(bot, 'dirt') <= 0 ? 'dirt' : 'hoe')
      else if (r === 'later') job.stats.skipped++
    }
    const water = layer.filter(c => c.kind === 'water')
    if (water.length) {
      for (const c of water) {
        if (token?.cancelled) return missing
        const b = bot.blockAt(c.pos)
        if (b && !bp.AIRS.has(b.name) && b.name !== 'water') {
          if (await clearCell(bot, c.pos, job, token)) job.holes?.add(kkey(c.pos))
        }
      }
      const left = await fillWater(bot, water, job, token)
      for (const c of water) job.holes?.add(kkey(c.pos))  // the channel stays out of its walks, filled or not
      if (left) missing.add('water_bucket')
    }
  }
  // things that hang on others, bottom up
  const attached = cells.filter(c => ATTACHED.has(c.kind) && !cellDone(bot, c) && c.item).sort((a, b) => a.pos.y - b.pos.y)
  for (const c of attached) {
    if (token?.cancelled) return missing
    if (cellDone(bot, c)) continue
    const r = await placeCell(bot, c, job, token)  // digs a plant out of the cell first
    if (r === 'missing') {
      if (c.kind !== 'crop') missing.add(c.item)
      else job.stats.unplanted++
    } else if (r === 'later') job.stats.skipped++
  }
  return missing
}

async function cleanup (bot, job, token) {
  // scaffolds top down
  for (const p of job.scaffolds.slice().sort((a, b) => b.y - a.y)) {
    if (token?.cancelled) return
    const b = bot.blockAt(p)
    if (b && SCAFFOLD.includes(b.name)) {
      if (await standFor(bot, p.offset(0.5, 0.5, 0.5), job, token, [p])) {
        await bot.dig(b, true)
        job.stats.dug++
      }
    }
  }
  job.scaffolds = []
  await pickUpTable(bot, job, token)
}

// The whole job. job: { blueprint, anchor (Vec3, the ground block), facing, hooks: { say, log, mine, builds, register } }
// Returns { result: 'done' | 'refused' | 'missing' | 'cancelled' | 'partial', message }
async function buildJob (bot, job, token) {
  const { say, log } = job.hooks
  job.stats = job.stats || { placed: 0, dug: 0, tilled: 0, water: 0, scaffolds: 0, crafted: 0, gathered: 0, wrongState: 0, skipped: 0, unplanted: 0, walks: 0, startedAt: Date.now(), endedAt: null }
  job.scaffolds = job.scaffolds || []
  const a = job.anchor
  const where = `${a.x} ${a.y + 1} ${a.z}`
  guardHoles(bot, job)
  try {
    // walk to the site so its chunks are in view
    if (bot.entity.position.distanceTo(a) > 12) {
      try { await goTo(bot, new goals.GoalNear(a.x, a.y + 1, a.z, 4), token, 60000) } catch (err) { log?.(`${bot.username} walk to the site: ${err.message}`) }
    }
    if (token?.cancelled) return { result: 'cancelled' }
    let todo = checkSite(bot, job)
    if (!job.announced) {
      job.announced = true
      say?.(`Building ${job.blueprint.name} at ${where}, front to the ${job.facing}`)
    }
    if (!todo.length) return finish(bot, job, 'done', `${job.blueprint.name} at ${where} is already built`)
    const lack = await getMaterials(bot, job, todo, token)
    if (token?.cancelled) return { result: 'cancelled' }
    if (lack) return finish(bot, job, 'missing', lack)
    todo = checkSite(bot, job)
    for (const c of toClear(bot, todo)) {
      if (token?.cancelled) return { result: 'cancelled' }
      await clearCell(bot, c.pos, job, token)
    }
    const missing = await placeLayers(bot, job, token)
    if (token?.cancelled) return { result: 'cancelled' }
    await cleanup(bot, job, token)
    if (token?.cancelled) return { result: 'cancelled' }
    const left = plan(bot, job).filter(c => c.kind !== 'air' && c.item && !cellDone(bot, c))
    const leftCrops = left.filter(c => c.kind === 'crop').length
    const leftOther = left.length - leftCrops
    if (leftOther) {
      job.hooks.register?.(job)  // !farm and !expand still find it, a second !build finishes it
      return finish(bot, job, 'partial', `Built most of ${job.blueprint.name}, ${leftOther} blocks left${missing.size ? `, short of ${[...missing].join(', ')}` : ''}`)
    }
    job.hooks.register?.(job)
    const mins = ((Date.now() - job.stats.startedAt) / 60000).toFixed(1)
    return finish(bot, job, 'done', `Built ${job.blueprint.name} at ${where} in ${mins} min${leftCrops ? `, ${leftCrops} spots wait for seeds` : ''}`)
  } catch (err) {
    if (token?.cancelled) return { result: 'cancelled' }
    if (err instanceof Refused) return finish(bot, job, 'refused', err.message)
    throw err
  }
}

function finish (bot, job, result, message) {
  if (bot._crewHoles === job.holes) bot._crewHoles = null
  job.stats.endedAt = Date.now()
  job.stats.result = result
  return { result, message }
}

module.exports = { climbOut, guardHoles, guardCells, hollowTops, kkey, buildJob, classify, cellDone, placedRight, refsFor, occupied, lookYaw, checkSite, needs, toClear, outsideIn, inBox, GoalReach, NATURAL, Refused, fillWater, till, placeCell, standFor, clearCell }
