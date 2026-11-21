// Scripted mining with mineflayer-pathfinder and bot.dig. Two strategies, picked by job.strategy:
//
//   old  the earlier miner, kept unchanged for the mining benchmark (crew.js --miner old). It goes for ore it could
//        plausibly know about (an open face it can see, plus anything within NOTICE blocks) and otherwise strip
//        mines one tunnel with the odd turn, down a staircase to the ore's usual height first.
//   new  branch mining at each ore's 1.21 depth, caving for iron, coal and copper, surface walks for logs and sand,
//        lava, gravel and drop safety, torches on the right wall, and the haul stored in a chest at home
//        (skills/mine_branch.js). It only mines ore with an exposed face it can see.
//
// Neither ever scans the whole loaded world for ore, which would read as X-ray. Both fill job.stats for the
// benchmark: blocks dug, ores mined, torches, stuck events, failed paths and lava blocked off.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./human')
const { goTo } = require('./move')

const SEE_RADIUS = { off: 24, light: 20, full: 16 }
const NOTICE = 4
const REACH = 4.4             // a little under the server's 4.5 block reach
const MAX_EXPLORE = 400      // blocks of tunnel before giving up
const PICKUP_MS = 4000
const DROP_WAIT_MS = 350
// where each ore is most common (Minecraft 1.18 and later), for the tunnelling
const BEST_Y = {
  diamond: -58, redstone: -58, lapis: 0, gold: -16, iron: 16, copper: 48, coal: 48, emerald: 100, quartz: null, debris: 15
}
const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

class MineError extends Error {}

function isExposed (bot, pos) {
  for (const [dx, dy, dz] of DIRS) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (!b || b.boundingBox === 'empty' || b.name === 'water' || b.name === 'lava') return true
  }
  return false
}

// Ore it can plausibly know about, nearest first
function visibleTargets (bot, ids, human) {
  const radius = SEE_RADIUS[human.level] ?? 20
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 200 })
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const out = []
  let checks = 0
  for (const pos of found) {
    const d = pos.offset(0.5, 0.5, 0.5).distanceTo(eye)
    if (d <= NOTICE) { out.push(pos); continue }
    if (!isExposed(bot, pos) || checks > 40) continue
    checks++
    const block = bot.blockAt(pos)
    if (block && bot.canSeeBlock(block)) out.push(pos)
  }
  return out
}

// The best tool it carries for this block, or a reason it has none
function pickTool (bot, block) {
  const items = bot.inventory.items()
  const need = block.harvestTools ? Object.keys(block.harvestTools).map(Number) : null
  const usable = need ? items.filter(i => need.includes(i.type)) : items
  if (need && !usable.length) {
    const hasPick = items.some(i => i.name.endsWith('_pickaxe'))
    return { error: hasPick ? `my pickaxe is too weak for ${block.name.replace(/_/g, ' ')}` : 'I have no pickaxe' }
  }
  let best = null
  let bestTime = block.digTime(null, false, false, false, [], [])
  for (const item of usable) {
    const t = block.digTime(item.type, false, false, false, [], bot.entity.effects ? Object.values(bot.entity.effects) : [])
    if (t < bestTime) { best = item; bestTime = t }
  }
  return { item: best }
}

async function equipFor (bot, block) {
  const pick = pickTool(bot, block)
  if (pick.error) throw new MineError(pick.error)
  if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
}

// Picks up drops around a spot
async function collectAround (bot, pos, token) {
  await sleep(DROP_WAIT_MS)
  const until = Date.now() + PICKUP_MS
  while (!token.cancelled && Date.now() < until) {
    const drop = Object.values(bot.entities).find(e => e.name === 'item' && e.position.distanceTo(pos) < 4)
    if (!drop) return
    try {
      await goTo(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.6), token)
    } catch { return }
    await sleep(250)
  }
}

async function placeTorch (bot, ctx) {
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) return false
  const feet = bot.entity.position.floored()
  const here = bot.blockAt(feet)
  const floor = bot.blockAt(feet.offset(0, -1, 0))
  if (!here || here.boundingBox !== 'empty' || here.name !== 'air' && here.name !== 'cave_air') return false
  if (!floor || floor.boundingBox !== 'block') return false
  const light = here.light ?? 15
  const sky = here.skyLight ?? 15
  if (Math.max(light, sky) >= 8) return false
  try {
    await bot.equip(torch, 'hand')
    await bot.placeBlock(floor, new Vec3(0, 1, 0))
    ctx.sinceTorch = 0
    ctx.torchGap = ctx.human.nextTorchGap()
    if (ctx.stats) ctx.stats.torches++
    return true
  } catch (err) {
    return false
  }
}

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LIQUID = new Set(['lava', 'water', 'flowing_lava', 'flowing_water'])
const CARDINAL = [[0, -1], [1, 0], [0, 1], [-1, 0]]  // yaw 0 faces -z in Mineflayer

// Lava or water in or next to a block it is about to open
function liquidNear (bot, pos) {
  for (const [dx, dy, dz] of [[0, 0, 0], ...DIRS]) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && LIQUID.has(b.name)) return true
  }
  return false
}

async function clearBlock (bot, pos, token) {
  for (let i = 0; i < 6 && !token.cancelled; i++) {  // gravel and sand fall back in
    const b = bot.blockAt(pos)
    // anything but air gets dug: snow layers, grass and flowers count as passable in the block data, and a snow
    // layer still held the bot up in the live test
    if (!b || AIR.has(b.name)) return true
    if (!b.diggable || LIQUID.has(b.name)) return false
    // the drop does not matter here, only that the block goes (snow wants a shovel to drop anything)
    const pick = pickTool(bot, b)
    if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
    await bot.dig(b, true)
    await sleep(80)
  }
  return false
}

// One block of tunnel, the way a player strip mines: dig the head and feet blocks ahead (and the one below them
// while going down a staircase), step in, then look around for ore again. Lava, water or a drop ahead turns it.
// Pathfinder could not plan long digs through solid rock (every 10 block stretch timed out in the live test)
async function exploreStep (bot, ctx, token) {
  if (ctx.heading === undefined) ctx.heading = bot.entity.yaw
  if (Math.random() < 0.08) ctx.heading += (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2  // the odd side turn
  const quarter = ((Math.round(ctx.heading / (Math.PI / 2)) % 4) + 4) % 4
  const [dx, dz] = CARDINAL[quarter]
  const feet = bot.entity.position.floored()
  const best = BEST_Y[ctx.label]
  const down = best !== null && best !== undefined && feet.y > best + 2
  const ahead = feet.offset(dx, 0, dz)
  const target = down ? ahead.offset(0, -1, 0) : ahead
  const open = down ? [ahead.offset(0, 1, 0), ahead, target] : [ahead.offset(0, 1, 0), ahead]
  const floor = bot.blockAt(target.offset(0, -1, 0))
  const blocked = open.some(p => liquidNear(bot, p)) || !floor || floor.boundingBox !== 'block' || LIQUID.has(floor.name)
  if (blocked) {
    ctx.heading += (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2
    ctx.turns = (ctx.turns || 0) + 1
    if (ctx.turns > 6) throw new Error('lava, water or a drop on every side')
    return
  }
  ctx.turns = 0
  for (const p of open) {
    if (!await clearBlock(bot, p, token)) {
      ctx.heading += Math.PI / 2
      throw new Error(`could not dig ${bot.blockAt(p)?.name ?? 'a block'} ahead`)
    }
  }
  await stepInto(bot, target, token)
  ctx.sinceTorch += 1
  ctx.tunnelled = (ctx.tunnelled || 0) + 1
  if (ctx.tunnelled % 10 === 0) ctx.log?.(`${bot.username} has tunnelled ${ctx.tunnelled} blocks, now at ${bot.entity.position.floored()}`)
}

// Water got in: walk back along its own tunnel to the last dry cell and turn away from the water
async function backOut (bot, ctx, token) {
  ctx.say?.('Water in my tunnel, backing out')
  const trail = bot.trail || []
  while (trail.length && bot.entity.isInWater && !token.cancelled) {
    const cell = trail.pop()
    try { await stepInto(bot, cell, token) } catch { break }
  }
  if (bot.entity.isInWater) {
    // no trail left: swim straight up and let the pathfinder find dry ground nearby
    bot.setControlState('jump', true)
    await bot.waitForTicks(20)
    bot.setControlState('jump', false)
  }
  ctx.heading = (ctx.heading ?? bot.entity.yaw) + Math.PI
}

// Walks into the next tunnel cell: steers at its centre every tick and lets go once over it, so it drops down a
// staircase step instead of resting on the edge of the block beyond (pathfinder timed out even on one block here)
async function stepInto (bot, cell, token) {
  bot.pathfinder.setGoal(null)
  const c = cell.offset(0.5, 0, 0.5)
  try {
    for (let t = 0; t < 60 && !token.cancelled; t++) {
      const p = bot.entity.position
      const dh = Math.hypot(p.x - c.x, p.z - c.z)
      if (dh < 0.25) {
        bot.setControlState('forward', false)
        if (Math.abs(p.y - c.y) < 0.6 && bot.entity.onGround) {
          if (bot.trail) {
            bot.trail.push(cell.clone())
            if (bot.trail.length > 60) bot.trail.shift()
          }
          return
        }
      } else {
        await bot.look(Math.atan2(-(c.x - p.x), -(c.z - p.z)), 0, true)
        bot.setControlState('forward', true)
      }
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
  }
  if (!token.cancelled) {
    const p = bot.entity.position
    const names = [0, 1].map(dy => bot.blockAt(cell.offset(0, dy, 0))?.name).join(' and ')
    throw new Error(`could not step into the tunnel at ${cell} (${names}), stuck at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  }
}

// Mines one block of the wanted kind. Returns 'mined', or 'none' after MAX_EXPLORE blocks of tunnel with nothing seen
async function mineOne (bot, ctx, token) {
  const { ids, human } = ctx
  for (let explored = 0; explored <= MAX_EXPLORE && !token.cancelled; explored++) {
    if (bot.entity.isInWater) await backOut(bot, ctx, token)
    if (bot.inventory.emptySlotCount() === 0) return 'full'
    const targets = visibleTargets(bot, ids, human).filter(p => !ctx.skip.has(p.toString()))
    if (!targets.length) {
      if (explored === MAX_EXPLORE) return 'none'
      if (!ctx.saidSearching) {
        ctx.say?.(`I don't see any ${ctx.label} yet, digging around for it`)
        ctx.saidSearching = true
      }
      // a pickaxe in hand before tunnelling, if it has one
      const pick = bot.inventory.items().find(i => i.name.endsWith('_pickaxe'))
      if (pick && bot.heldItem?.type !== pick.type) await bot.equip(pick, 'hand')
      await exploreStep(bot, ctx, token)
      if (human.placesTorches && ctx.sinceTorch >= ctx.torchGap) await placeTorch(bot, ctx)
      if (explored % 5 === 4) await human.idleMoment(token)
      continue
    }
    const pos = targets[0]
    if (liquidNear(bot, pos)) {
      // opening it would flood the tunnel (a bot drowned this way in the live test)
      ctx.skip.add(pos.toString())
      continue
    }
    ctx.log?.(`${bot.username} sees ${ctx.label} at ${pos}`)
    const block = bot.blockAt(pos)
    if (!block || !ids.includes(block.type)) continue
    await equipFor(bot, block)
    const start = bot.entity.position.clone()
    const inReach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= REACH
    try {
      // ore in reach (most ore in a tunnel wall) is dug from where it stands: the pathfinder timed out on these
      if (!inReach()) {
        const detour = human.detourPoint(start, pos)
        if (detour) {
          try { await goTo(bot, new goals.GoalNear(detour.x, detour.y, detour.z, 1), token, 8000) } catch {}
        }
        await goTo(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), token)
      }
    } catch (err) {
      // an ore it cannot reach is left alone from now on, so it does not walk at it forever
      ctx.skip.add(pos.toString())
      if (ctx.stats) ctx.stats.pathFails++
      ctx.log?.(`${bot.username} gives up on ${ctx.label} at ${pos}: ${err.message}`)
      continue
    }
    if (token.cancelled) return 'cancelled'
    ctx.sinceTorch += Math.round(start.distanceTo(bot.entity.position))
    const again = bot.blockAt(pos)
    if (!again || !ids.includes(again.type)) continue
    await equipFor(bot, again)  // the walk may have dug with another tool
    await human.lookAtPoint(pos.offset(0.5, 0.5, 0.5), token)
    if (token.cancelled) return 'cancelled'
    await bot.dig(again, true)
    await collectAround(bot, pos.offset(0.5, 0.5, 0.5), token)
    if (human.placesTorches && ctx.sinceTorch >= ctx.torchGap) await placeTorch(bot, ctx)
    await human.idleMoment(token)
    return 'mined'
  }
  return 'cancelled'
}

// Counts every block the bot digs, its own digs and the pathfinder's, through one wrapper per bot. A job reads
// the counter before and after, so a fight pausing the job or a second job never double counts
function digCounter (bot) {
  if (!bot._crewDigCount) {
    const counter = { n: 0 }
    const dig = bot.dig
    bot.dig = async function (...args) {
      const r = await dig.apply(bot, args)
      counter.n++
      return r
    }
    bot._crewDigCount = counter
  }
  return bot._crewDigCount
}

function newStats (strategy) {
  return {
    strategy,
    mode: strategy === 'old' ? 'tunnel' : 'branch',
    dug: 0,
    ores: 0,
    torches: 0,
    stuck: 0,
    pathFails: 0,
    lavaBlocked: 0,
    startedAt: Date.now(),
    endedAt: null
  }
}

// A mining job: count blocks of any of these names. Keeps its progress in job, so a fight can pause it and it
// carries on after. say() sends a chat line. job.strategy 'old' runs the earlier miner, anything else the new one
async function mineJob (bot, job, human, token, hooks = {}) {
  const ids = job.blocks.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  if (!ids.length) return { result: 'unknown', message: `"${job.block}" is not a block I know` }
  // ores need a pickaxe of some tier: say so now instead of tunnelling with bare hands
  const need = new Set(job.blocks.flatMap(n => Object.keys(bot.registry.blocksByName[n]?.harvestTools || {}).map(Number)))
  if (need.size && !bot.inventory.items().some(i => need.has(i.type))) {
    const hasPick = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
    return { result: 'no_tool', message: hasPick ? `My pickaxe is too weak for ${job.block}` : 'I have no pickaxe' }
  }
  const strategy = job.strategy === 'old' ? 'old' : 'new'
  if (!job.stats) job.stats = newStats(strategy)
  const counter = digCounter(bot)
  const before = counter.n
  try {
    if (strategy === 'old') return await oldMineJob(bot, job, ids, human, token, hooks)
    // required here, mine_branch.js uses this file's helpers
    return await require('./mine_branch').branchMineJob(bot, job, ids, human, token, hooks)
  } finally {
    job.stats.dug += counter.n - before
    job.stats.endedAt = Date.now()
  }
}

// The earlier loop, unchanged apart from the counting
async function oldMineJob (bot, job, ids, human, token, { say, log, onMined } = {}) {
  const ctx = job.ctx || (job.ctx = { ids, human, label: job.block, sinceTorch: 0, torchGap: human.nextTorchGap(), say, skip: new Set() })
  ctx.human = human
  ctx.log = log
  ctx.onMined = onMined
  ctx.say = say
  ctx.stats = job.stats
  while (job.mined < job.count && !token.cancelled) {
    let r
    try {
      r = await mineOne(bot, ctx, token)
    } catch (err) {
      if (token.cancelled) break
      if (err instanceof MineError) return { result: 'no_tool', message: err.message }
      // a path that failed (blocked, too far): count it as a tunnel stretch and look again
      job.failures = (job.failures || 0) + 1
      job.stats.stuck++
      log?.(`${bot.username} mining: ${err.message}`)
      // a stretch that failed turns the tunnel, so it does not try the same wall again
      ctx.heading = (ctx.heading ?? bot.entity.yaw) + (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2
      if (job.failures > 12) return { result: 'stuck', message: `I keep getting stuck, stopping with ${job.mined} ${job.block}` }
      await sleep(500)
      continue
    }
    if (r === 'mined') {
      job.mined++
      job.stats.ores++
      ctx.onMined?.(job)
    }
    if (r === 'full') return { result: 'full', message: 'Inventory full, coming back' }
    if (r === 'none') return { result: 'none', message: `I couldn't find any more ${job.block} nearby (${job.mined} so far)` }
  }
  if (token.cancelled) return { result: 'cancelled' }
  return { result: 'done', message: `Got ${job.mined} ${job.block}` }
}

module.exports = {
  mineJob,
  liquidNear,
  goTo,
  visibleTargets,
  pickTool,
  isExposed,
  equipFor,
  collectAround,
  stepInto,
  backOut,
  digCounter,
  MineError,
  PICKAXES,
  BEST_Y,
  SEE_RADIUS,
  NOTICE,
  REACH,
  AIR,
  LIQUID
}
