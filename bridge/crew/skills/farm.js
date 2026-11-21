// Farming like a villager farmer: tends a crop farm built from a blueprint (wheat_farm, the plains village farm, by
// default). It walks the rows, harvests ripe crops, replants, tills trampled farmland again and puts the harvest in
// a chest by the farm, then waits by the entrance for the next crops to ripen. It never ends on its own, !stop or
// !stay ends it. foodFromFarm feeds a hungry bot from its farm (B5): ripe crops first, then the farm chest, and bread
// from 3 wheat on a crafting table it places and picks back up.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')
const bp = require('./blueprint')
const { placeCell, till, standFor, inBox, guardCells, hollowTops, kkey } = require('./build')
const { collectDrops, count } = require('./gather')
const { findContainers, deposit, withdraw, contents, placeChestNear } = require('./storage')
const { planItems, craftAll, pickUpTable } = require('./craft')
const { countItems } = require('./storage')

const CROPS = {
  wheat: { block: 'wheat', seed: 'wheat_seeds', produce: 'wheat', ripe: 7 },
  carrot: { block: 'carrots', seed: 'carrot', produce: 'carrot', ripe: 7 },
  potato: { block: 'potatoes', seed: 'potato', produce: 'potato', ripe: 7 }
}
const KEEP_SEEDS = 32
const STORE_AT = 16
const WAIT_MS = 20000
const FARM_RANGE = 64

// A blueprint with its crop cells planted with another crop (wheat_farm with carrots or potatoes)
function withCrop (b, crop) {
  const block = CROPS[crop]?.block
  if (!b || !block || block === 'wheat') return b
  const out = JSON.parse(JSON.stringify(b))
  for (const [k, v] of Object.entries(out.palette)) {
    const name = typeof v === 'string' ? v : v.name
    if (bp.CROPS[name]) out.palette[k] = block
  }
  return out
}

// The farm's blueprint as built: its modules added and its crop swapped
function farmBlueprint (record, crop, load = bp.loadBlueprint) {
  const base = record.blueprintData || load(record.blueprint)
  if (!base) return null
  let b = base
  if (record.modules && record.modules > 1 && base.expand) b = bp.expandBlueprint(base, record.modules - 1)
  return withCrop(b, crop)
}

// The crop and farmland cells of a farm record
function farmCells (bot, record, crop) {
  const b = farmBlueprint(record, crop)
  if (!b) return null
  const anchor = new Vec3(record.anchor[0], record.anchor[1], record.anchor[2])
  const cells = bp.planCells(b, anchor, record.facing, bot.registry)
  return {
    blueprint: b,
    cells,
    crops: cells.filter(c => c.kind === 'crop'),
    farmland: cells.filter(c => c.kind === 'farmland'),
    box: bp.footprint(cells),
    anchor
  }
}

// The nearest farm the crew built within range of a point, or null
function nearestFarm (farms, point, range = FARM_RANGE) {
  let best = null
  for (const f of farms) {
    const a = new Vec3(f.anchor[0], f.anchor[1], f.anchor[2])
    const d = a.distanceTo(point)
    if (d <= range && (!best || d < best.d)) best = { f, d }
  }
  return best ? best.f : null
}

function ripe (block, crop) {
  return !!block && block.name === CROPS[crop].block && Number(block.getProperties().age) >= CROPS[crop].ripe
}

// One walk along the rows: harvest what is ripe, plant what is empty, till what got trampled
async function tendOnce (bot, job, farm, token) {
  const crop = CROPS[job.crop]
  const stats = job.stats
  const work = { hooks: job.hooks, stats: job.workStats, box: farm.box, anchor: farm.anchor, scaffolds: [] }
  // nearest first along a snake through the rows
  const order = farm.crops.slice().sort((a, b) => (a.pos.x - b.pos.x) || ((a.pos.x % 2 ? -1 : 1) * (a.pos.z - b.pos.z)))
  for (const c of order) {
    if (token?.cancelled) return
    const block = bot.blockAt(c.pos)
    const below = bot.blockAt(c.pos.offset(0, -1, 0))
    if (!block || !below) continue
    if (ripe(block, job.crop)) {
      if (!await standFor(bot, c.pos.offset(0.5, 0.3, 0.5), work, token, [])) continue
      await bot.dig(block, true)
      stats.harvested++
      await collectDrops(bot, c.pos.offset(0.5, 0.5, 0.5), token)
    }
    const now = bot.blockAt(c.pos)
    if (now && bp.AIRS.has(now.name)) {
      if (['dirt', 'grass_block'].includes(bot.blockAt(c.pos.offset(0, -1, 0))?.name)) {
        const fl = farm.farmland.find(f => f.pos.equals(c.pos.offset(0, -1, 0)))
        if (fl && await till(bot, fl, work, token) === 'placed') stats.retilled++
      }
      if (count(bot, crop.seed) > 0 && bot.blockAt(c.pos.offset(0, -1, 0))?.name === 'farmland') {
        const r = await placeCell(bot, { ...c, item: crop.seed }, work, token)
        if (r === 'placed') stats.planted++
      }
    }
  }
}

// Puts the harvest in a chest by the farm (one it places when there is none and it carries one)
async function store (bot, job, farm, token) {
  const crop = CROPS[job.crop]
  const extraSeeds = Math.max(0, count(bot, crop.seed) - KEEP_SEEDS)
  const produce = crop.produce === crop.seed ? Math.max(0, count(bot, crop.produce) - KEEP_SEEDS) : count(bot, crop.produce)
  if (produce < STORE_AT && extraSeeds < 64) return 0
  const centre = farm.box.min.plus(farm.box.max).scaled(0.5).floored()
  let chests = findContainers(bot, centre, 12, 4)
  if (!chests.length) {
    if (!bot.inventory.items().some(i => i.name === 'chest')) {
      const tableNear = bot.findBlocks({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6, count: 1 }).length > 0
      const p = planItems(bot.registry, new Map([['chest', 1]]), countItems(bot), { tableNear })
      if (!p.missing.size && !p.gather.size) {
        await craftAll(bot, p.crafts, job, token, { avoid: q => inBox(q, farm.box, 1), log: job.hooks.log })
        await pickUpTable(bot, job, token)
      }
    }
    const spot = await placeChestNear(bot, farm.anchor.offset(0, 1, 0), token, { avoid: q => inBox(q, farm.box, 0) })
    if (!spot) {
      job.hooks.say?.('No chest by the farm, I keep the harvest')
      return 0
    }
    chests = [spot]
  }
  let keepSeeds = KEEP_SEEDS
  const filter = item => {
    if (item.name === crop.produce && crop.produce !== crop.seed) return true
    if (item.name === crop.seed) {
      // keep enough to replant
      if (keepSeeds >= item.count) { keepSeeds -= item.count; return false }
      return true
    }
    return false
  }
  const n = await deposit(bot, chests[0], filter, token)
  job.stats.stored += n
  return n
}

// The farm job. job: { crop, farm (a record or null), here (Vec3 anchor or null), facing, maxCycles, hooks:
// { say, log, farms(), build(blueprintName, anchor, facing, token) } }
async function farmJob (bot, job, token) {
  job.stats = job.stats || { cycles: 0, harvested: 0, planted: 0, retilled: 0, stored: 0, startedAt: Date.now(), endedAt: null }
  job.workStats = job.workStats || { placed: 0, dug: 0, tilled: 0, walks: 0, wrongState: 0 }
  const { say } = job.hooks
  if (!CROPS[job.crop]) return { result: 'unknown', message: `I can't farm ${job.crop}, try wheat, carrot or potato` }
  if (!job.farm) {
    const point = job.here || bot.entity.position
    job.farm = nearestFarm(job.hooks.farms?.() || [], point, job.here ? 24 : FARM_RANGE)
  }
  if (!job.farm) {
    if (!job.here) return { result: 'none', message: 'I know no farm near here, say !farm wheat here to build one' }
    const r = await job.hooks.build('wheat_farm', job.here, job.facing, token, job.crop)
    if (token?.cancelled) return { result: 'cancelled' }
    if (r.result !== 'done' && r.result !== 'partial') return r
    job.farm = r.record || nearestFarm(job.hooks.farms?.() || [], job.here, 24)
    if (!job.farm) return { result: 'none', message: 'The farm is built but I lost track of it' }
  }
  let farm = farmCells(bot, job.farm, job.crop)
  if (!farm) return { result: 'unknown', message: `I lost the blueprint of ${job.farm.blueprint}` }
  if (!job.announced) {
    job.announced = true
    say?.(`Farming ${job.crop} at ${farm.anchor.x} ${farm.anchor.y + 1} ${farm.anchor.z}`)
  }
  while (!token?.cancelled) {
    // again every round, so a module added with !expand gets tended too
    farm = farmCells(bot, job.farm, job.crop) || farm
    // never walk in the water channel: one live test lost 13 minutes trying to get out of it
    // and never on top of the composter, its hollow top swallowed the bot in a later run
    guardCells(bot, new Set([...farm.cells.filter(c => c.kind === 'water').map(c => kkey(c.pos)), ...hollowTops(farm.cells)]))
    await tendOnce(bot, job, farm, token)
    if (token?.cancelled) break
    await store(bot, job, farm, token)
    job.stats.cycles++
    if (job.maxCycles && job.stats.cycles >= job.maxCycles) break
    // wait by the entrance until something is ripe
    try { await goTo(bot, new goals.GoalNear(farm.anchor.x, farm.anchor.y + 1, farm.anchor.z, 2), token, 20000) } catch {}
    const until = Date.now() + WAIT_MS
    while (!token?.cancelled && Date.now() < until) {
      if (farm.crops.some(c => ripe(bot.blockAt(c.pos), job.crop))) break
      await sleep(1000)
    }
  }
  job.stats.endedAt = Date.now()
  bot._crewHoles = null
  if (token?.cancelled) return { result: 'cancelled' }
  return { result: 'done', message: `Farm round done: ${job.stats.harvested} harvested, ${job.stats.planted} planted, ${job.stats.stored} stored` }
}

// A hungry bot with no food: ripe crops from the nearest farm, else food from the farm chest, then bread from wheat.
// Returns food points it now carries
async function foodFromFarm (bot, farms, token, { log = () => {}, foodPoints = () => 0 } = {}) {
  const record = nearestFarm(farms, bot.entity.position, 96)
  if (!record) return 0
  const crop = record.crop || 'wheat'
  const farm = farmCells(bot, record, crop)
  if (!farm) return 0
  const job = { crop, hooks: { log }, stats: { harvested: 0, planted: 0, retilled: 0, stored: 0 }, workStats: { placed: 0, dug: 0, tilled: 0, walks: 0, wrongState: 0 } }
  await tendOnce(bot, job, farm, token)
  if (token?.cancelled) return foodPoints()
  // the farm chest
  if (foodPoints() < 6 && count(bot, 'wheat') < 3) {
    const centre = farm.box.min.plus(farm.box.max).scaled(0.5).floored()
    for (const pos of findContainers(bot, centre, 12, 4)) {
      try {
        const have = await contents(bot, pos, token)
        const wants = new Map()
        for (const k of ['bread', 'baked_potato', 'carrot', 'potato', 'wheat']) if (have.get(k)) wants.set(k, Math.min(have.get(k), k === 'wheat' ? 9 : 4))
        if (wants.size) await withdraw(bot, pos, wants, token)
      } catch (err) {
        log(`${bot.username} farm chest: ${err.message}`)
      }
    }
  }
  // bread, 3 wheat a loaf
  const loaves = Math.min(3, Math.floor(count(bot, 'wheat') / 3))
  if (loaves > 0 && !token?.cancelled) {
    try {
      await craftAll(bot, [{ name: 'bread', times: loaves, table: true }], job, token, { avoid: q => inBox(q, farm.box, 1), log })
      await pickUpTable(bot, job, token)
    } catch (err) {
      log(`${bot.username} bread: ${err.message}`)
    }
  }
  return foodPoints()
}

module.exports = { farmJob, foodFromFarm, farmCells, farmBlueprint, withCrop, nearestFarm, tendOnce, store, CROPS, ripe }
