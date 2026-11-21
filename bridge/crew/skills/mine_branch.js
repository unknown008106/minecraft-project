// The new miner (job.strategy 'new'), mining the way a careful player does in 1.21:
//
// 1. Ore it can see. Only ore with an open face counts: a face on a tunnel or cave cell it has stood in or dug
//    (every exposed face it walks past gets checked), or a face it can see from where it stands. Ore buried in rock
//    is never found, so there is no X-ray, not even the old miner's 4 block notice.
// 2. Caves for iron, coal and copper: rays from its eyes in every direction, like looking around, find dark open
//    air it can see. It walks to the farthest spot of the cave it has not been to, torches it, and looks again.
// 3. Branch mining for everything else and whenever no cave is in sight: a staircase down to the ore's best depth,
//    then a main tunnel with a branch to each side every 3 blocks (2 solid blocks between branches, so every block
//    between them has an exposed face), back to the main tunnel after each branch.
// 4. Logs, sand, dirt and the like: walks on the surface and looks again.
// 5. Safety: lava behind a wall it is about to open makes it turn, lava it can see next to it gets a block, lava
//    or water under its next step gets a block, a hole gets a bridge block or, with no blocks, is only stepped into
//    when the fall is 3 blocks or less. Gravel and sand above a block are waited out before it steps under them.
//    A water bucket goes on its feet when it burns and on lava when it has no block to place. Torches go on the
//    right wall going in, and it records its path so it can walk back out.
// 6. Done, given up or bag full: walks home along its path and puts the haul in a chest within 8 blocks of home
//    (skills/storage.js). A full bag sends it back down to the mine afterwards. job.store false (the builder
//    gathering materials) walks home and keeps the haul in its bag.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./human')
const { goTo } = require('./move')
const { findContainers, storeAtHome } = require('./storage')
const { pickTool, equipFor, collectAround, stepInto, backOut, MineError, SEE_RADIUS, REACH, AIR } = require('./mine')

// Where each ore is most common in Java Edition 1.21, read from the Minecraft wiki pages
// minecraft.wiki/w/Diamond_Ore, Redstone_Ore, Lapis_Lazuli_Ore, Gold_Ore, Iron_Ore, Copper_Ore, Coal_Ore, Emerald_Ore
// and Ancient_Debris (Natural generation sections):
//   diamond   Y 16 down to -63, more common lower, deepslate diamond ore most common at Y -58 and -59
//   redstone  even from -64 to 15, plus a batch from -63 to -32 that is more common the lower it goes
//   lapis     most common around Y 0 (-32 to 32), plus an even batch from -64 to 64 that never touches air
//   gold      most common around Y -16 (-64 to 32), extra in badlands from 32 to 256
//   iron      most common around Y 16 (-24 to 56), around Y 232 in mountains, plus an even batch from -64 to 72
//   copper    most common at Y 47 and 48 (-16 to 112)
//   coal      most common at Y 96 (0 to 192), plus an even batch from 136 to 320
//   emerald   mountain biomes only, the actual quantity peaks around Y 90
//   debris    the Nether, Y 16 has the most on average
// The tunnel's feet stand at this height. When it is above the start (coal, emerald) the bot mines just under the
// surface, it never climbs to reach a depth.
const BEST_Y = { diamond: -58, redstone: -58, lapis: 0, gold: -16, iron: 16, copper: 48, coal: 96, emerald: 90, debris: 16, quartz: null }
// Diamonds stay branch mined: the same pages say half or more of the diamond ore that would touch air is never
// generated. Iron and copper are not thinned out next to air and coal only by half, so caves pay off for them.
const CAVE_ORES = new Set(['iron', 'coal', 'copper'])
const SURFACE = /(_log|_stem|_leaves)$|^(sand|red_sand|gravel|dirt|grass_block|clay|snow_block|pumpkin|melon|sugar_cane|cactus|mud)$/

const TUNING = {
  branchGap: 3,     // a branch every 3 blocks of main tunnel, 2 solid blocks between branches
  branchLen: 12,    // blocks per branch
  mainLen: 60       // then the main tunnel turns
}
const MAX_STEPS = 500       // tunnel and cave moves without ore before it gives up
const MAX_WANDERS = 25      // surface walks of about 18 blocks without the block it wants
const MAX_FAILURES = 12
const MAX_SAFE_DROP = 3     // a fall of 3 blocks does no damage
const KEEP_BLOCKS = 32      // cobblestone and the like kept for blocking lava and bridging
const MAX_DIG_MS = 8000     // blocks slower than this with its best tool are left alone (obsidian with stone)
const FALL_TICKS = 16       // long enough for gravel to drop a block or two and land
const HOME_STEP = 6         // waypoints along its own path on the way home
const CAVE_MIN_CELLS = 6
const CAVE_DRY_LIMIT = 25   // cave moves without ore before it sticks to branch mining

const LAVA = new Set(['lava'])
const WATER = new Set(['water', 'bubble_column'])
const FALLING = new Set(['gravel', 'sand', 'red_sand', 'suspicious_sand', 'suspicious_gravel'])
const BLOCKING = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone']
// never dug on the way: things a player placed or that matter (a chest's items would spill)
const NEVER_DIG = /(chest|barrel|shulker_box|_bed|_door|crafting_table|furnace|smoker|torch|lantern|_sign|anvil|enchanting_table|spawner|bedrock|end_portal_frame)$/
// never put in the chest: its tools, armour, light, buckets and the chest it may still need
const KEEP_ITEM = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots)$|^(shield|bow|crossbow|arrow|torch|bucket|water_bucket|lava_bucket|flint_and_steel|shears|chest|crafting_table)$/
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

const key = p => `${p.x},${p.y},${p.z}`
const fmt = p => `${p.x} ${p.y} ${p.z}`
const turnRight = d => ({ x: -d.z, z: d.x })  // clockwise seen from above: north, east, south, west
const turnLeft = d => ({ x: d.z, z: -d.x })
const isSolid = b => !!b && b.boundingBox === 'block'
const isOpen = b => !!b && AIR.has(b.name)
const isFalling = b => !!b && (FALLING.has(b.name) || /_concrete_powder$/.test(b.name))
const feetCell = bot => {
  const p = bot.entity.position
  return new Vec3(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z))
}
const standingIn = (bot, cell) => feetCell(bot).equals(cell)

// The cardinal direction the bot looks along (Mineflayer yaw 0 looks at -z, north)
function facingDir (yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  return Math.abs(dx) > Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) || -1 }
}

function dirBetween (a, b) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  if (!dx && !dz) return null
  return Math.abs(dx) > Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) }
}

// Lava or water in a cell or next to it, the cells in skip aside (peeking behind the wall it is about to open is
// a safety check the old miner made too)
function liquidAround (bot, cell, kinds, skip = []) {
  for (const [dx, dy, dz] of [[0, 0, 0], ...NEIGHBOURS]) {
    const p = cell.offset(dx, dy, dz)
    if (skip.some(s => s.equals(p))) continue
    const b = bot.blockAt(p)
    if (b && kinds.has(b.name)) return true
  }
  return false
}

// How far it would fall stepping into this cell, 0 with a floor under it, 99 over lava, water or the void
function dropDepth (bot, feet) {
  for (let d = 1; d <= 8; d++) {
    const b = bot.blockAt(feet.offset(0, -d, 0))
    if (!b || LAVA.has(b.name) || WATER.has(b.name)) return 99
    if (isSolid(b)) return d - 1
  }
  return 99
}

// Where it ends up stepping into a cell: the cell, or the floor of a drop of 3 blocks or less under it
function landingCell (bot, cell) {
  const d = dropDepth(bot, cell)
  return d > 0 && d <= MAX_SAFE_DROP ? cell.offset(0, -d, 0) : cell
}

function blockingItem (bot) {
  for (const name of BLOCKING) {
    const it = bot.inventory.items().find(i => i.name === name)
    if (it) return it
  }
  return null
}

function standable (bot, cell) {
  const feet = bot.blockAt(cell)
  const head = bot.blockAt(cell.offset(0, 1, 0))
  const floor = bot.blockAt(cell.offset(0, -1, 0))
  return isOpen(feet) && isOpen(head) && isSolid(floor)
}

// The path it walked, so it can walk back out. Stepping into a cell already on the path cuts the loop off
function recordCell (ctx, cell) {
  if (ctx.homing) return
  const k = key(cell)
  const i = ctx.pathIndex.get(k)
  if (i !== undefined) {
    for (const c of ctx.path.splice(i + 1)) ctx.pathIndex.delete(key(c))
    return
  }
  ctx.pathIndex.set(k, ctx.path.length)
  ctx.path.push(cell.clone())
}

// Ore it could know about: an open face on a cell it has been in or dug and not too far off, or a face it can see
function seenOre (bot, ctx) {
  const radius = SEE_RADIUS[ctx.human.level] ?? 20
  const found = bot.findBlocks({ matching: ctx.ids, maxDistance: radius, count: 200 })
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const out = []
  let checks = 0
  for (const pos of found) {
    if (ctx.skip.has(key(pos))) continue
    const faces = NEIGHBOURS.map(([dx, dy, dz]) => pos.offset(dx, dy, dz)).filter(p => {
      const b = bot.blockAt(p)
      return b && b.boundingBox === 'empty'
    })
    if (!faces.length) continue  // buried in rock: nobody could know it is there
    const d = pos.offset(0.5, 0.5, 0.5).distanceTo(eye)
    if (d <= 6 && faces.some(f => ctx.ownCells.has(key(f)) || ctx.pathIndex.has(key(f)))) {
      out.push(pos)
      continue
    }
    if (checks++ > 60) continue
    const block = bot.blockAt(pos)
    if (block && bot.canSeeBlock(block)) out.push(pos)
  }
  return out
}

async function digOne (bot, ctx, block) {
  const pick = pickTool(bot, block)
  if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
  const ms = block.digTime(pick.item?.type ?? null, false, false, false, [], bot.entity.effects ? Object.values(bot.entity.effects) : [])
  if (ms > MAX_DIG_MS) throw new Error(`${block.name.replace(/_/g, ' ')} is too hard to dig with what I carry`)
  await bot.dig(block, true)
}

// Waits until something lands in the cell (gravel or sand from above) or a few ticks pass
async function waitFall (bot, cell) {
  for (let i = 0; i < FALL_TICKS; i++) {
    await bot.waitForTicks(1)
    const b = bot.blockAt(cell)
    if (b && !AIR.has(b.name)) return
  }
}

// Opens the cells top to bottom. Gravel or sand above a cell comes down when it is dug: it waits for it to land
// and digs again, and gravel resting over the open column gets dug too, so it never steps under a falling block
async function openColumn (bot, ctx, cells, token) {
  for (let tries = 0; tries < 24 && !token.cancelled; tries++) {
    const shut = cells.find(c => !isOpen(bot.blockAt(c)))
    if (!shut) {
      const above = bot.blockAt(cells[0].offset(0, 1, 0))
      if (!isFalling(above)) return true
      await digOne(bot, ctx, above)
      ctx.ownCells.add(key(above.position))
      await waitFall(bot, cells[0])
      continue
    }
    const b = bot.blockAt(shut)
    if (!b || LAVA.has(b.name) || WATER.has(b.name) || !b.diggable || NEVER_DIG.test(b.name)) return false
    const fallingAbove = isFalling(bot.blockAt(shut.offset(0, 1, 0)))
    await digOne(bot, ctx, b)
    ctx.ownCells.add(key(shut))
    if (fallingAbove) await waitFall(bot, shut)
    else await sleep(60)
  }
  return false
}

// Puts a block from its bag into a cell (lava, water or air), clicking the nearest solid neighbour in reach
async function placeInto (bot, ctx, cell, token) {
  const item = blockingItem(bot)
  if (!item) return false
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const options = []
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const ref = bot.blockAt(cell.offset(dx, dy, dz))
    if (!isSolid(ref)) continue
    const point = ref.position.offset(0.5 - dx * 0.5, 0.5 - dy * 0.5, 0.5 - dz * 0.5)
    const dist = point.distanceTo(eye)
    if (dist > REACH) continue
    options.push({ ref, face: new Vec3(-dx, -dy, -dz), dist })
  }
  options.sort((a, b) => a.dist - b.dist)
  for (const o of options) {
    if (token?.cancelled) return false
    try {
      await bot.equip(item, 'hand')
      await bot.placeBlock(o.ref, o.face)
      ctx.ownCells.delete(key(cell))
      return true
    } catch (err) {
      ctx.log?.(`${bot.username} could not place a block at ${cell}: ${err.message}`)
    }
  }
  return false
}

const onFire = bot => !!bot.entity.isInLava || !!((bot.entity.metadata?.[0] ?? 0) & 0x01)

async function useBucket (bot, look) {
  await look()
  await bot.waitForTicks(2)  // the look reaches the server before the use, it aims the bucket with it
  await bot.activateItem()
}

// Water on its own feet when it burns or stands in lava, then the water back in the bucket
async function douse (bot, ctx, token) {
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket')
  if (!bucket) return false
  await bot.equip(bucket, 'hand')
  await useBucket(bot, () => bot.look(bot.entity.yaw, -Math.PI / 2, true))
  ctx.stats.waterUsed = (ctx.stats.waterUsed || 0) + 1
  ctx.say?.('I was burning, put water on myself')
  await sleep(1200)
  await scoopWater(bot, token)
  return true
}

// Water onto lava it sees, when it has no block to put there, then the water back
async function pourOnLava (bot, ctx, cell, token) {
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket')
  if (!bucket) return false
  await bot.equip(bucket, 'hand')
  await useBucket(bot, () => bot.lookAt(cell.offset(0.5, 0.1, 0.5), true))
  ctx.stats.waterUsed = (ctx.stats.waterUsed || 0) + 1
  await sleep(1000)
  await scoopWater(bot, token)
  return true
}

async function scoopWater (bot, token) {
  if (token?.cancelled) return
  const empty = bot.inventory.items().find(i => i.name === 'bucket')
  if (!empty) return
  const feet = feetCell(bot)
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        const p = feet.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || b.name !== 'water' || (b.getProperties?.().level ?? 0) !== 0) continue
        await bot.equip(empty, 'hand')
        await useBucket(bot, () => bot.lookAt(p.offset(0.5, 0.5, 0.5), true))
        return
      }
    }
  }
}

// Lava it can see within a couple of blocks: lava cells touching open air near its feet
function visibleLavaNear (bot, r = 2) {
  const feet = feetCell(bot)
  const out = []
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = feet.offset(dx, dy, dz)
        const b = bot.blockAt(p)
        if (!b || !LAVA.has(b.name)) continue
        if (NEIGHBOURS.some(([x, y, z]) => isOpen(bot.blockAt(p.offset(x, y, z))))) out.push(p)
      }
    }
  }
  return out
}

// The reflexes checked before every move
async function keepSafe (bot, ctx, token) {
  if (onFire(bot)) await douse(bot, ctx, token)
  if (bot.entity.isInWater) {
    await backOut(bot, ctx, token)
    ctx.plan = null
  }
  for (const cell of visibleLavaNear(bot)) {
    if (token.cancelled) return
    if (await placeInto(bot, ctx, cell, token) || await pourOnLava(bot, ctx, cell, token)) {
      ctx.stats.lavaBlocked++
      ctx.say?.('Lava next to me, blocked it off')
    }
  }
}

// Gets the next cell ready to step into: no lava or water behind the walls it opens, nothing a player placed in
// the way, the column dug with gravel waited out, and a floor it can stand on (a block over lava, water or a hole,
// or a fall of 3 blocks or less). Returns 'ok', 'lava', 'water', 'placed', 'dig' or 'drop'
async function openWay (bot, ctx, cells, feet, token) {
  const floor = feet.offset(0, -1, 0)
  for (const c of cells) {
    if (liquidAround(bot, c, LAVA, [floor])) {
      ctx.stats.lavaBlocked++
      ctx.say?.('Lava behind the wall, going around it')
      return 'lava'
    }
    if (liquidAround(bot, c, WATER, [floor])) return 'water'
    const b = bot.blockAt(c)
    if (b && NEVER_DIG.test(b.name)) return 'placed'
  }
  if (!await openColumn(bot, ctx, cells, token)) return 'dig'
  const fb = bot.blockAt(floor)
  if (isSolid(fb)) return 'ok'
  if (fb && (LAVA.has(fb.name) || WATER.has(fb.name))) {
    if (!await placeInto(bot, ctx, floor, token)) return LAVA.has(fb.name) ? 'lava' : 'water'
    if (LAVA.has(fb.name)) {
      ctx.stats.lavaBlocked++
      ctx.say?.('Lava under my path, blocked it off')
    }
    return 'ok'
  }
  // a hole under the next step: a bridge block, or a small drop
  const depth = dropDepth(bot, feet)
  if (await placeInto(bot, ctx, floor, token)) return 'ok'
  return depth <= MAX_SAFE_DROP ? 'ok' : 'drop'
}

// A torch on the right hand wall (going in) at head height, or at foot height, once the light is low and enough
// blocks have passed since the last one
async function torchRightWall (bot, ctx, d, token) {
  if (!d || ctx.sinceTorch < ctx.torchGap || token.cancelled) return false
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) return false
  const feet = feetCell(bot)
  const head = bot.blockAt(feet.offset(0, 1, 0))
  if (!head) return false
  if (Math.max(head.light ?? 0, head.skyLight ?? 0) >= 8) return false
  const r = turnRight(d)
  for (const dy of [1, 0]) {
    const cell = feet.offset(0, dy, 0)
    const wall = bot.blockAt(cell.offset(r.x, 0, r.z))
    if (!isOpen(bot.blockAt(cell)) || !isSolid(wall)) continue
    try {
      await bot.equip(torch, 'hand')
      await bot.placeBlock(wall, new Vec3(-r.x, 0, -r.z))
      ctx.sinceTorch = 0
      ctx.torchGap = ctx.human.nextTorchGap()
      ctx.stats.torches++
      return true
    } catch (err) {
      ctx.log?.(`${bot.username} torch: ${err.message}`)
    }
  }
  return false
}

// A torch on the floor at its feet, for open cave floors without a wall on the right
async function torchFloor (bot, ctx, token) {
  if (ctx.sinceTorch < ctx.torchGap || token.cancelled) return false
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) return false
  const feet = feetCell(bot)
  const here = bot.blockAt(feet)
  const floor = bot.blockAt(feet.offset(0, -1, 0))
  if (!isOpen(here) || !isSolid(floor)) return false
  if (Math.max(here.light ?? 0, here.skyLight ?? 0) >= 8) return false
  try {
    await bot.equip(torch, 'hand')
    await bot.placeBlock(floor, new Vec3(0, 1, 0))
    ctx.sinceTorch = 0
    ctx.torchGap = ctx.human.nextTorchGap()
    ctx.stats.torches++
    return true
  } catch (err) {
    return false
  }
}

// Stepped into a new cell
function arrive (bot, ctx, d) {
  recordCell(ctx, feetCell(bot))
  ctx.sinceTorch++
  if (d) ctx.lastDir = d
}

// One block of tunnel in direction d from where it stands
async function tunnelStep (bot, ctx, d, token) {
  const cur = feetCell(bot)
  const next = cur.offset(d.x, 0, d.z)
  const r = await openWay(bot, ctx, [next.offset(0, 1, 0), next], next, token)
  if (r !== 'ok') return r
  await stepInto(bot, landingCell(bot, next), token)
  arrive(bot, ctx, d)
  await torchRightWall(bot, ctx, d, token)
  return 'ok'
}

// One step of the staircase down: head, feet and the step below ahead, then down into it
async function descendStep (bot, ctx, plan, token) {
  const d = plan.dir
  const ahead = plan.at.offset(d.x, 0, d.z)
  const target = ahead.offset(0, -1, 0)
  const r = await openWay(bot, ctx, [ahead.offset(0, 1, 0), ahead, target], target, token)
  if (r !== 'ok') return turnMain(ctx, plan, r)
  await stepInto(bot, landingCell(bot, target), token)
  arrive(bot, ctx, d)
  plan.at = feetCell(bot)
  plan.cur = plan.at
  plan.turns = 0
  ctx.stats.descended = (ctx.stats.descended || 0) + 1
  if (plan.at.y <= ctx.targetY) {
    plan.phase = 'branch'
    resetGrid(plan)
    ctx.say?.(`At Y ${plan.at.y}, branch mining for ${ctx.label}`)
  }
  await torchRightWall(bot, ctx, d, token)
}

function resetGrid (plan) {
  plan.s = 0
  plan.mainLen = 0
  plan.branched = new Set()
  plan.branch = null
}

// The way ahead is blocked: the main tunnel (or the staircase) turns left or right and a new branch grid starts
function turnMain (ctx, plan, why) {
  plan.turns++
  if (plan.turns > 6) throw new Error('lava, water or a drop on every side')
  plan.dir = Math.random() < 0.5 ? turnLeft(plan.dir) : turnRight(plan.dir)
  resetGrid(plan)
  ctx.stats.turns = (ctx.stats.turns || 0) + 1
  ctx.log?.(`turning the tunnel (${why})`)
}

function newPlan (bot, ctx) {
  const at = feetCell(bot)
  return {
    phase: at.y > ctx.targetY ? 'descend' : 'branch',
    dir: ctx.lastDir || facingDir(bot.entity.yaw),
    at,        // where it should stand now
    cur: at,   // the main tunnel cell the branches start from
    s: 0,
    mainLen: 0,
    branch: null,
    branched: new Set(),
    turns: 0
  }
}

// Back to the cell its plan says it stands in (after a fight, an ore or picking up drops took it away)
async function ensureAt (bot, ctx, cell, token) {
  if (standingIn(bot, cell)) return true
  try {
    await goTo(bot, new goals.GoalBlock(cell.x, cell.y, cell.z), token, 15000)
  } catch (err) {
    ctx.stats.pathFails++
    return false
  }
  if (token.cancelled) return false
  recordCell(ctx, feetCell(bot))
  return standingIn(bot, cell)
}

// Walks back along cells (newest first) to the main tunnel, step by step, the pathfinder as the fallback
async function walkBack (bot, ctx, cells, to, token) {
  for (let i = cells.length - 2; i >= 0 && !token.cancelled; i--) {
    try {
      await stepInto(bot, cells[i], token)
      recordCell(ctx, feetCell(bot))
    } catch {
      break
    }
  }
  if (!token.cancelled && !standingIn(bot, to)) {
    try {
      await stepInto(bot, to, token)
      recordCell(ctx, feetCell(bot))
    } catch {
      await ensureAt(bot, ctx, to, token)
    }
  }
}

// One move of branch mining: a staircase step down, a block of branch, or a block of main tunnel
async function branchStep (bot, ctx, token) {
  if (!ctx.plan) ctx.plan = newPlan(bot, ctx)
  const plan = ctx.plan
  if (!await ensureAt(bot, ctx, plan.at, token)) {
    ctx.plan = null
    throw new Error(`could not get back to my tunnel at ${fmt(plan.at)}`)
  }
  ctx.stats.mode = ctx.caving && !ctx.caveOff ? 'cave' : 'branch'
  if (plan.phase === 'descend') return descendStep(bot, ctx, plan, token)
  const t = ctx.tuning
  if (!plan.branch && t.branchLen > 0 && plan.s % t.branchGap === 0 && !plan.branched.has(plan.s)) {
    plan.branch = { side: -1, len: 0, cells: [plan.cur.clone()] }
  }
  if (plan.branch) {
    const b = plan.branch
    const d = b.side < 0 ? turnLeft(plan.dir) : turnRight(plan.dir)
    if (b.len < t.branchLen) {
      const r = await tunnelStep(bot, ctx, d, token)
      if (r === 'ok') {
        b.len++
        b.cells.push(feetCell(bot))
        plan.at = feetCell(bot)
        return
      }
      ctx.log?.(`${bot.username} ends a branch early (${r})`)
    }
    // the branch is done: back to the main tunnel, then the other side or on along the main tunnel
    await walkBack(bot, ctx, b.cells, plan.cur, token)
    plan.at = plan.cur
    ctx.stats.branches = (ctx.stats.branches || 0) + 1
    if (b.side < 0) plan.branch = { side: 1, len: 0, cells: [plan.cur.clone()] }
    else {
      plan.branch = null
      plan.branched.add(plan.s)
    }
    return
  }
  if (plan.mainLen >= t.mainLen) {
    plan.dir = turnRight(plan.dir)
    resetGrid(plan)
    return
  }
  const r = await tunnelStep(bot, ctx, plan.dir, token)
  if (r !== 'ok') return turnMain(ctx, plan, r)
  plan.at = feetCell(bot)
  plan.cur = plan.at
  plan.s++
  plan.mainLen++
  plan.turns = 0
}

// Looks around the way a player does: rays from its eyes in every direction, each stopped by the first solid
// block. Dark open cells the rays pass through, and that it did not dig itself, are cave it can see
function lookForCave (bot, ctx, maxDist = 16) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const seen = new Map()
  for (let yi = 0; yi < 16; yi++) {
    const yaw = yi * Math.PI / 8
    for (const pitch of [-0.9, -0.5, -0.2, 0, 0.25, 0.6]) {
      const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      for (let t = 1; t <= maxDist; t += 0.5) {
        const p = eye.plus(dir.scaled(t)).floored()
        const b = bot.blockAt(p)
        if (!b || b.boundingBox === 'block' || LAVA.has(b.name) || WATER.has(b.name)) break
        if ((b.skyLight ?? 15) >= 8) continue  // open sky, not a cave
        const k = key(p)
        if (ctx.ownCells.has(k) || ctx.pathIndex.has(k) || seen.has(k)) continue
        seen.set(k, { p, t })
      }
    }
  }
  return [...seen.values()]
}

const region = p => `${Math.floor(p.x / 4)},${Math.floor(p.y / 4)},${Math.floor(p.z / 4)}`

function markVisited (ctx, p) {
  const [rx, ry, rz] = region(p).split(',').map(Number)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) ctx.visited.add(`${rx + dx},${ry + dy},${rz + dz}`)
    }
  }
}

// One cave move: to the farthest standing spot of a cave it can see and has not been to. False with no cave in sight
async function caveStep (bot, ctx, token) {
  markVisited(ctx, feetCell(bot))
  const cells = lookForCave(bot, ctx)
  if (cells.length < CAVE_MIN_CELLS) return false
  const spots = cells
    .filter(c => c.t >= 3 && !ctx.visited.has(region(c.p)) && standable(bot, c.p) && !liquidAround(bot, c.p, LAVA))
    .sort((a, b) => b.t - a.t)
  if (!spots.length) return false
  const spot = spots[0].p
  if (!ctx.saidCave) {
    ctx.say?.(`Following a cave for ${ctx.label}`)
    ctx.saidCave = true
  }
  const from = feetCell(bot)
  ctx.stats.mode = 'cave'
  try {
    await goTo(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 1), token, 20000)
  } catch (err) {
    ctx.stats.pathFails++
    markVisited(ctx, spot)
    return true
  }
  if (token.cancelled) return true
  const here = feetCell(bot)
  recordCell(ctx, here)
  markVisited(ctx, here)
  ctx.plan = null  // branch mining starts again from wherever the cave left it
  ctx.caveMoves++
  ctx.caveDry++
  ctx.stats.caveMoves = ctx.caveMoves
  ctx.sinceTorch += Math.round(from.distanceTo(here))
  const d = dirBetween(from, here)
  if (d) ctx.lastDir = d
  if (!await torchRightWall(bot, ctx, d, token)) await torchFloor(bot, ctx, token)
  if (ctx.caveDry >= CAVE_DRY_LIMIT) {
    ctx.caveOff = true
    ctx.say?.(`No ${ctx.label} in these caves, branch mining instead`)
  }
  return true
}

// One surface walk of about 18 blocks in a mostly steady direction, for logs, sand and the like
async function surfaceStep (bot, ctx, token) {
  if (ctx.wanderYaw === undefined || Math.random() < 0.3) ctx.wanderYaw = Math.random() * 2 * Math.PI
  const p = bot.entity.position
  const dist = 14 + Math.random() * 8
  const gx = p.x - Math.sin(ctx.wanderYaw) * dist
  const gz = p.z - Math.cos(ctx.wanderYaw) * dist
  ctx.stats.mode = 'surface'
  try {
    await goTo(bot, new goals.GoalNearXZ(gx, gz, 3), token, 25000)
  } catch (err) {
    ctx.stats.pathFails++
    ctx.wanderYaw += Math.PI / 2
  }
  recordCell(ctx, feetCell(bot))
}

// Walks to an ore it saw (when out of reach) and digs it
async function mineTarget (bot, ctx, pos, token) {
  const { ids, human } = ctx
  if (liquidAround(bot, pos, LAVA) || liquidAround(bot, pos, WATER)) {
    // opening it would let lava or water in
    ctx.skip.add(key(pos))
    return 'skip'
  }
  const block = bot.blockAt(pos)
  if (!block || !ids.includes(block.type)) return 'skip'
  await equipFor(bot, block)
  const inReach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= REACH
  if (!inReach()) {
    try {
      const detour = human.detourPoint(bot.entity.position, pos)
      if (detour) {
        try { await goTo(bot, new goals.GoalNear(detour.x, detour.y, detour.z, 1), token, 8000) } catch {}
      }
      await goTo(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), token)
    } catch (err) {
      ctx.skip.add(key(pos))
      ctx.stats.pathFails++
      ctx.log?.(`${bot.username} gives up on ${ctx.label} at ${pos}: ${err.message}`)
      return 'skip'
    }
    if (token.cancelled) return 'cancelled'
    recordCell(ctx, feetCell(bot))
  }
  const again = bot.blockAt(pos)
  if (!again || !ids.includes(again.type)) return 'skip'
  await equipFor(bot, again)
  await human.lookAtPoint(pos.offset(0.5, 0.5, 0.5), token)
  if (token.cancelled) return 'cancelled'
  const fallingAbove = isFalling(bot.blockAt(pos.offset(0, 1, 0)))
  await bot.dig(again, true)
  ctx.ownCells.add(key(pos))
  if (fallingAbove) await waitFall(bot, pos)
  await collectAround(bot, pos.offset(0.5, 0.5, 0.5), token)
  await human.idleMoment(token)
  return 'mined'
}

// What goes into the chest: everything but its tools, armour, torches, buckets, food and the biggest stacks of
// cobblestone and the like up to KEEP_BLOCKS
function haulFilter (bot) {
  const keep = name => KEEP_ITEM.test(name) || !!bot.registry.foodsByName?.[name]
  return item => {
    if (keep(item.name)) return false
    if (!BLOCKING.includes(item.name)) return true
    const stacks = bot.inventory.items().filter(i => BLOCKING.includes(i.name)).sort((a, b) => b.count - a.count)
    let kept = 0
    for (const s of stacks) {
      if (kept >= KEEP_BLOCKS) break
      if (s === item || (s.slot !== undefined && s.slot === item.slot)) return false
      kept += s.count
    }
    return true
  }
}

// Home along its own path, waypoint by waypoint, then to home itself
async function goHome (bot, job, ctx, token) {
  ctx.homing = true
  try {
    const cells = ctx.path.slice().reverse()
    for (let i = HOME_STEP; i < cells.length && !token.cancelled; i += HOME_STEP) {
      const c = cells[i]
      try {
        await goTo(bot, new goals.GoalBlock(c.x, c.y, c.z), token, 20000)
      } catch (err) {
        try { await goTo(bot, new goals.GoalNear(c.x, c.y, c.z, 2), token, 15000) } catch { ctx.stats.pathFails++ }
      }
    }
    const h = job.home
    if (!token.cancelled && bot.entity.position.distanceTo(h.offset(0.5, 0, 0.5)) > 2.5) {
      try { await goTo(bot, new goals.GoalNear(h.x, h.y, h.z, 2), token, 30000) } catch { ctx.stats.pathFails++ }
    }
    return !token.cancelled && bot.entity.position.distanceTo(h.offset(0.5, 0, 0.5)) <= 4
  } finally {
    ctx.homing = false
  }
}

// Out to the mining face again along its own path, after emptying a full bag at home
async function backToFace (bot, ctx, token) {
  ctx.homing = true
  try {
    const cells = ctx.path
    for (let i = HOME_STEP; i < cells.length + HOME_STEP && !token.cancelled; i += HOME_STEP) {
      const c = cells[Math.min(i, cells.length - 1)]
      try {
        await goTo(bot, new goals.GoalBlock(c.x, c.y, c.z), token, 20000)
      } catch (err) {
        try { await goTo(bot, new goals.GoalNear(c.x, c.y, c.z, 2), token, 15000) } catch { ctx.stats.pathFails++ }
      }
    }
  } finally {
    ctx.homing = false
  }
}

function canStoreAtHome (bot, ctx) {
  return ctx.homeChest || bot.inventory.items().some(i => i.name === 'chest')
}

// Counts what left the bag itself, the item counts a chest window reports back are not reliable
async function storeHaul (bot, job, ctx, token) {
  const filter = haulFilter(bot)
  const carried = () => bot.inventory.items().filter(filter).reduce((n, i) => n + i.count, 0)
  const before = carried()
  if (!before) return { stored: 0, reason: 'nothing to store' }
  const r = await storeAtHome(bot, job.home, filter, token, { log: ctx.log })
  const stored = Math.max(0, before - carried())
  ctx.stats.stored = (ctx.stats.stored || 0) + stored
  return { ...r, stored }
}

// The job ended (done, none or stuck): home, the haul into the chest, and the message says where it went.
// job.store false (the builder gathering coal or cobblestone) walks back out to home and keeps the haul
async function finishAtHome (bot, job, ctx, token, end) {
  if (job.store === false) {
    if (job.home && bot.entity.position.distanceTo(job.home.offset(0.5, 0, 0.5)) > 4) await goHome(bot, job, ctx, token)
    return token.cancelled ? { result: 'cancelled' } : end
  }
  if (!job.home || !bot.inventory.items().some(haulFilter(bot))) return end
  if (!canStoreAtHome(bot, ctx)) return { ...end, message: `${end.message}, no chest at home so I kept it` }
  await goHome(bot, job, ctx, token)
  if (token.cancelled) return { result: 'cancelled' }
  const s = await storeHaul(bot, job, ctx, token)
  if (s.stored > 0) return { ...end, message: `${end.message}, put ${s.stored} items in the chest at ${fmt(s.pos)}` }
  return { ...end, message: `${end.message}, no chest at home so I kept it` }
}

// A full bag: home, empty it into the chest, back to the face. 'ok' to go on mining, 'full' when it could not
async function unloadAndReturn (bot, job, ctx, token) {
  if (job.store === false || !canStoreAtHome(bot, ctx)) return 'full'
  ctx.say?.('Bag full, taking the haul home')
  await goHome(bot, job, ctx, token)
  if (token.cancelled) return 'cancelled'
  const s = await storeHaul(bot, job, ctx, token)
  if (!s.stored || bot.inventory.emptySlotCount() === 0) return 'full'
  ctx.say?.(`Put ${s.stored} items in the chest at home, going back down`)
  await backToFace(bot, ctx, token)
  if (token.cancelled) return 'cancelled'
  return 'ok'  // the plan carries on where it stopped
}

// The depth to mine at: the ore's best depth, never above where it starts, and at least 6 blocks under open sky
function targetDepth (bot, label) {
  const feet = feetCell(bot)
  const best = BEST_Y[label]
  const head = bot.blockAt(feet.offset(0, 1, 0))
  const underSky = (head?.skyLight ?? 0) >= 8
  let t = best === null || best === undefined ? feet.y : Math.min(best, feet.y)
  if (underSky) t = Math.min(t, feet.y - 6)
  return Math.max(t, -58)
}

function setup (bot, job, ids, human, hooks) {
  if (!job.home) job.home = feetCell(bot)
  if (!job.ctx) {
    job.ctx = {
      ids,
      label: job.block,
      skip: new Set(),
      ownCells: new Set(),
      path: [],
      pathIndex: new Map(),
      visited: new Set(),
      sinceTorch: 0,
      torchGap: human.nextTorchGap(),
      steps: 0,
      failures: 0,
      plan: null,
      caving: CAVE_ORES.has(job.block),
      caveOff: false,
      caveMoves: 0,
      caveDry: 0,
      surface: job.blocks.every(n => SURFACE.test(n)),
      wanders: 0,
      targetY: targetDepth(bot, job.block),
      tuning: { ...TUNING, ...(job.tuning || {}) },
      homeChest: findContainers(bot, job.home, 8, 1).length > 0
    }
  }
  const ctx = job.ctx
  ctx.ids = ids
  ctx.human = human
  ctx.say = hooks.say
  ctx.log = hooks.log
  ctx.onMined = hooks.onMined
  ctx.stats = job.stats
  ctx.stats.mode = ctx.surface ? 'surface' : ctx.caving ? 'cave' : 'branch'
  return ctx
}

// The new mining job, called by mineJob in mine.js (which keeps the counts and the end time)
// A tool in the bag that can harvest the wanted blocks (a pickaxe for ore), or true when they need none
function hasHarvestTool (bot, job) {
  const need = new Set(job.blocks.flatMap(n => Object.keys(bot.registry.blocksByName[n]?.harvestTools || {}).map(Number)))
  return !need.size || bot.inventory.items().some(i => need.has(i.type))
}

// A player going deep with one pickaxe brings wood for sticks and a crafting table, so a broken pickaxe is a new
// stone one from the cobblestone it dug. With one pickaxe and no wood, it chops 2 logs from a tree it can see first
async function bringWood (bot, ctx, token) {
  const items = bot.inventory.items()
  if (items.filter(i => i.name.endsWith('_pickaxe')).length > 1) return
  if (items.some(i => /_log$|_planks$|^stick$|^crafting_table$/.test(i.name))) return
  const { gather, visible, LOGS } = require('./gather')
  const seen = visible(bot, LOGS, () => false, { logs: true })
  if (!seen.length) return
  const log = bot.blockAt(seen[0])?.name
  if (!log) return
  ctx.say?.('Getting 2 logs first, for sticks and a crafting table if my pickaxe breaks')
  try {
    await gather(bot, log, 2, token, { log: ctx.log || (() => {}) })
  } catch (err) {
    ctx.log?.(`${bot.username} wood for spare tools: ${err.message}`)
  }
}

// A new stone pickaxe from cobblestone and wood in the bag, on a crafting table it places and picks back up
async function replacePickaxe (bot, ctx, token) {
  const { planItems, craftAll, pickUpTable } = require('./craft')
  const { countItems } = require('./storage')
  const tableNear = bot.findBlocks({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6, count: 1 }).length > 0
  const p = planItems(bot.registry, new Map([['stone_pickaxe', 1]]), countItems(bot), { tableNear })
  if (p.missing.size || p.gather.size) return false
  const work = ctx.craftJob || (ctx.craftJob = {})
  try {
    await craftAll(bot, p.crafts, work, token, { log: ctx.log || (() => {}) })
    await pickUpTable(bot, work, token)
  } catch (err) {
    ctx.log?.(`${bot.username} new pickaxe: ${err.message}`)
    return false
  }
  if (!bot.inventory.items().some(i => i.name === 'stone_pickaxe')) return false
  ctx.say?.('My pickaxe broke, I made a new stone one')
  return true
}

async function branchMineJob (bot, job, ids, human, token, hooks = {}) {
  const ctx = setup(bot, job, ids, human, hooks)
  recordCell(ctx, feetCell(bot))
  if (!job.prepared) {
    job.prepared = true
    if (!ctx.surface) await bringWood(bot, ctx, token)
  }
  while (job.mined < job.count && !token.cancelled) {
    try {
      if (bot.inventory.emptySlotCount() === 0) {
        const r = await unloadAndReturn(bot, job, ctx, token)
        if (r === 'cancelled') break
        if (r === 'full') return { result: 'full', message: 'Inventory full, coming back' }
        continue
      }
      // the pickaxe broke: a new one when the bag allows, else home with what it has (it went on digging by hand
      // for 22 minutes in one live test)
      if (!hasHarvestTool(bot, job)) {
        if (await replacePickaxe(bot, ctx, token)) continue
        return finishAtHome(bot, job, ctx, token, { result: 'no_tool', message: `My pickaxe broke, I stop with ${job.mined} ${job.block}` })
      }
      await keepSafe(bot, ctx, token)
      if (token.cancelled) break
      const targets = seenOre(bot, ctx)
      if (targets.length) {
        ctx.log?.(`${bot.username} sees ${ctx.label} at ${targets[0]}`)
        const r = await mineTarget(bot, ctx, targets[0], token)
        if (r === 'mined') {
          job.mined++
          job.stats.ores++
          ctx.steps = 0
          ctx.caveDry = 0
          ctx.onMined?.(job)
        }
        continue
      }
      if (ctx.surface ? ctx.wanders >= MAX_WANDERS : ctx.steps >= MAX_STEPS) {
        return finishAtHome(bot, job, ctx, token, { result: 'none', message: `I couldn't find any more ${job.block} nearby (${job.mined} so far)` })
      }
      if (!ctx.saidSearching) {
        ctx.say?.(ctx.surface
          ? `I don't see any ${ctx.label} yet, walking around for it`
          : `I don't see any ${ctx.label} yet, ${ctx.caving ? 'looking for caves and ' : ''}branch mining at Y ${ctx.targetY}`)
        ctx.saidSearching = true
      }
      // a pickaxe in hand before tunnelling, if it has one
      const pick = bot.inventory.items().find(i => i.name.endsWith('_pickaxe'))
      if (pick && bot.heldItem?.type !== pick.type && !ctx.surface) await bot.equip(pick, 'hand')
      if (ctx.surface) {
        ctx.wanders++
        await surfaceStep(bot, ctx, token)
      } else if (!(ctx.caving && !ctx.caveOff && await caveStep(bot, ctx, token))) {
        await branchStep(bot, ctx, token)
      }
      ctx.steps++
      if (ctx.steps % 5 === 4) await human.idleMoment(token)
    } catch (err) {
      if (token.cancelled) break
      if (err instanceof MineError) return { result: 'no_tool', message: err.message }
      ctx.failures++
      job.failures = ctx.failures
      job.stats.stuck++
      ctx.log?.(`${bot.username} mining: ${err.message}`)
      ctx.plan = null
      ctx.lastDir = Math.random() < 0.5 ? turnLeft(ctx.lastDir || facingDir(bot.entity.yaw)) : turnRight(ctx.lastDir || facingDir(bot.entity.yaw))
      if (ctx.failures > MAX_FAILURES) {
        return finishAtHome(bot, job, ctx, token, { result: 'stuck', message: `I keep getting stuck, stopping with ${job.mined} ${job.block}` })
      }
      await sleep(500)
    }
  }
  if (token.cancelled) return { result: 'cancelled' }
  return finishAtHome(bot, job, ctx, token, { result: 'done', message: `Got ${job.mined} ${job.block}` })
}

module.exports = {
  branchMineJob,
  hasHarvestTool,
  replacePickaxe,
  bringWood,
  BEST_Y,
  CAVE_ORES,
  TUNING,
  targetDepth,
  haulFilter,
  lookForCave,
  facingDir,
  turnRight,
  turnLeft,
  dropDepth
}
