// The builder and the farm on a fake world, no server needed:  node --test bridge/crew/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const bp = require('../skills/blueprint')
const { buildJob, classify, cellDone } = require('../skills/build')
const { craftAll } = require('../skills/craft')
const { planItems } = require('../skills/craft')
const { farmJob, tendOnce, farmCells, foodFromFarm } = require('../skills/farm')

// Water as the game does it: an empty cell between two sources (with a floor) becomes a source
function withWater (bot, world) {
  const tick = bot.waitForTicks
  bot.waitForTicks = async n => {
    await tick(n)
    for (let pass = 0; pass < 2; pass++) {
      for (const [k, v] of [...world.blocks]) {
        if (v.name !== 'water') continue
        const [x, y, z] = k.split(',').map(Number)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const p = new Vec3(x + dx, y, z + dz)
          if (world.name(p) !== 'air' || !world.solid(p.offset(0, -1, 0))) continue
          const sources = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([ex, ez]) => world.name(p.offset(ex, 0, ez)) === 'water').length
          if (sources >= 2) world.set(p, 'water', { level: 0 })
        }
      }
    }
  }
}

function hooks (log = []) {
  return { say: t => log.push(t), log: () => {}, builds: () => [], register: job => { job.record = { blueprint: job.blueprint.name, anchor: [job.anchor.x, job.anchor.y, job.anchor.z], facing: job.facing, modules: 1, crop: 'wheat' } } }
}

test('a block he could have placed in the footprint stops the build before anything is dug', async () => {
  const { bot, world } = makeBot()
  world.set(new Vec3(3, 63, 0), 'oak_planks')
  const said = []
  const job = { blueprint: bp.loadBlueprint('wheat_farm'), anchor: new Vec3(0, 63, 0), facing: 'west', hooks: hooks(said) }
  const r = await buildJob(bot, job, { cancelled: false })
  assert.equal(r.result, 'refused')
  assert.match(r.message, /oak planks at 3 63 0 could be yours/)
  assert.equal(world.digs, 0)
})

test('natural blocks are fine to clear, his are not', () => {
  const { bot, world } = makeBot()
  // a natural oak: logs up into leaves the game placed
  for (let y = 64; y <= 68; y++) world.set(new Vec3(10, y, 10), 'oak_log', { axis: 'y' })
  for (let x = 8; x <= 12; x++) for (let z = 8; z <= 12; z++) world.set(new Vec3(x, 69, z), 'oak_leaves', { distance: 1, persistent: false, waterlogged: false })
  // his log pillar, and leaves he placed
  for (let y = 64; y <= 66; y++) world.set(new Vec3(20, y, 20), 'oak_log', { axis: 'y' })
  world.set(new Vec3(21, 64, 20), 'oak_leaves', { distance: 1, persistent: true, waterlogged: false })
  world.set(new Vec3(22, 64, 20), 'poppy')
  world.set(new Vec3(23, 64, 20), 'chest', { facing: 'north', type: 'single', waterlogged: false })
  world.set(new Vec3(24, 63, 20), 'farmland', { moisture: 0 })
  const c = p => classify(bot, bot.blockAt(p), { scaffolds: [] })
  assert.equal(c(new Vec3(10, 64, 10)), 'natural')
  assert.equal(c(new Vec3(10, 69, 10)), 'natural')
  assert.equal(c(new Vec3(20, 64, 20)), 'placed')
  assert.equal(c(new Vec3(21, 64, 20)), 'placed')
  assert.equal(c(new Vec3(22, 64, 20)), 'natural')
  assert.equal(c(new Vec3(23, 64, 20)), 'placed')
  assert.equal(c(new Vec3(24, 63, 20)), 'placed')
  assert.equal(c(new Vec3(0, 63, 0)), 'natural')
})

test('it says exactly what is missing and builds nothing', async () => {
  const { bot, world } = makeBot()
  bot.give('oak_log', 40)
  bot.give('coal', 2)
  const said = []
  const job = { blueprint: bp.loadBlueprint('small_hut'), anchor: new Vec3(0, 63, 0), facing: 'north', hooks: hooks(said) }
  const r = await buildJob(bot, job, { cancelled: false })
  assert.equal(r.result, 'missing')
  assert.match(r.message, /I still need 1 white_bed/)
  assert.equal(world.placed, 0)
})

test('the village wheat farm gets built from a kit: border, channel, farmland, wheat, composter', async () => {
  const { bot, world } = makeBot()
  withWater(bot, world)
  bot.give('oak_log', 28)
  bot.give('wheat_seeds', 27)
  bot.give('water_bucket', 2)
  bot.give('composter', 1)
  bot.give('stone_hoe', 1)
  const said = []
  const anchor = new Vec3(0, 63, 0)
  const job = { blueprint: bp.loadBlueprint('wheat_farm'), anchor, facing: 'west', hooks: hooks(said) }
  const r = await buildJob(bot, job, { cancelled: false })
  assert.equal(r.result, 'done', r.message)
  // every cell right, checked against the plan
  const cells = bp.planCells(job.blueprint, anchor, 'west', bot.registry)
  const wrong = cells.filter(c => !cellDone(bot, c)).map(c => `${c.name}@${c.pos}`)
  assert.deepEqual(wrong, [])
  assert.equal(job.stats.tilled, 27)
  assert.equal(job.stats.wrongState, 0)
  // it fills the 7 long channel from 2 buckets
  assert.ok(job.stats.water <= 4, `poured ${job.stats.water} times`)
  assert.ok(said.some(t => /Building wheat_farm/.test(t)))
  assert.ok(job.record, 'registered')
})

test('the small hut turned east: logs, slabs, a door and a bed facing the right way', async () => {
  const { bot, world } = makeBot()
  bot.give('oak_planks', 64)
  bot.give('oak_log', 12)
  bot.give('oak_slab', 25)
  bot.give('oak_door', 1)
  bot.give('white_bed', 1)
  bot.give('torch', 2)
  const anchor = new Vec3(0, 63, 0)
  const job = { blueprint: bp.loadBlueprint('small_hut'), anchor, facing: 'east', hooks: hooks() }
  const r = await buildJob(bot, job, { cancelled: false })
  assert.equal(r.result, 'done', r.message)
  const cells = bp.planCells(job.blueprint, anchor, 'east', bot.registry)
  assert.deepEqual(cells.filter(c => !cellDone(bot, c)).map(c => `${c.name}@${c.pos}`), [])
  assert.equal(job.stats.wrongState, 0)
  const door = cells.find(c => c.name === 'oak_door' && c.props.half === 'lower')
  assert.equal(world.props(door.pos).facing, 'west')
  const bed = cells.find(c => c.name === 'white_bed' && c.props.part === 'foot')
  assert.equal(world.props(bed.pos).facing, bed.props.facing)
  // the roof is bottom slabs
  const slab = cells.find(c => c.name === 'oak_slab')
  assert.equal(world.props(slab.pos).type, 'bottom')
})

test('a build cut short carries on later without refusing its own blocks', async () => {
  const { bot, world } = makeBot()
  bot.give('cobblestone', 23)
  bot.give('cobblestone_wall', 7)
  bot.give('oak_log', 6)
  const token = { cancelled: false }
  const place = bot._placeBlockWithOptions
  let n = 0
  bot._placeBlockWithOptions = async (...a) => { if (++n === 10) token.cancelled = true; return place(...a) }
  const job = { blueprint: bp.loadBlueprint('wall'), anchor: new Vec3(0, 63, 0), facing: 'north', hooks: hooks() }
  assert.equal((await buildJob(bot, job, token)).result, 'cancelled')
  const r = await buildJob(bot, job, { cancelled: false })
  assert.equal(r.result, 'done', r.message)
  assert.ok(world.placed >= 36)
})

test('crafting on a table it places and picks back up', async () => {
  const { bot, world } = makeBot()
  bot.give('oak_log', 3)
  const p = planItems(bot.registry, new Map([['composter', 1]]), new Map([['oak_log', 3]]))
  const job = {}
  await craftAll(bot, p.crafts, job, { cancelled: false })
  assert.equal(bot.countOf('composter'), 1)
  assert.ok(job.tableOurs)
  const { pickUpTable } = require('../skills/craft')
  await pickUpTable(bot, job, { cancelled: false })
  assert.equal(job.table, null)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.ok(world.placed >= 1)
})

test('the farm job harvests ripe wheat, replants and stores the harvest in a chest', async () => {
  const { bot, world } = makeBot()
  withWater(bot, world)
  bot.give('oak_log', 28)
  bot.give('wheat_seeds', 27)
  bot.give('water_bucket', 2)
  bot.give('composter', 1)
  bot.give('stone_hoe', 1)
  const anchor = new Vec3(0, 63, 0)
  const job = { blueprint: bp.loadBlueprint('wheat_farm'), anchor, facing: 'west', hooks: hooks() }
  assert.equal((await buildJob(bot, job, { cancelled: false })).result, 'done')
  // all of it ripens, and a chest stands by the farm
  const record = job.record
  const farm = farmCells(bot, record, 'wheat')
  for (const c of farm.crops) world.set(c.pos, 'wheat', { age: 7 })
  world.fillChest(new Vec3(-1, 64, 6), [])
  const fjob = { crop: 'wheat', farm: record, maxCycles: 1, hooks: { say: () => {}, log: () => {}, farms: () => [record] } }
  const r = await farmJob(bot, fjob, { cancelled: false })
  assert.equal(r.result, 'done', r.message)
  assert.equal(fjob.stats.harvested, 27)
  assert.equal(fjob.stats.planted, 27)
  for (const c of farm.crops) assert.equal(Number(world.props(c.pos).age), 0)
  const chest = world.containers.get('-1,64,6')
  assert.equal(chest.filter(i => i.name === 'wheat').reduce((n, i) => n + i.count, 0), 27)
  assert.ok(bot.countOf('wheat_seeds') >= 27, 'keeps seeds to replant')
})

test('a hungry bot with no food bakes bread from its farm', async () => {
  const { bot, world } = makeBot()
  withWater(bot, world)
  bot.give('oak_log', 30)
  bot.give('wheat_seeds', 27)
  bot.give('water_bucket', 2)
  bot.give('composter', 1)
  bot.give('stone_hoe', 1)
  const anchor = new Vec3(0, 63, 0)
  const job = { blueprint: bp.loadBlueprint('wheat_farm'), anchor, facing: 'west', hooks: hooks() }
  assert.equal((await buildJob(bot, job, { cancelled: false })).result, 'done')
  const farm = farmCells(bot, job.record, 'wheat')
  for (const c of farm.crops.slice(0, 9)) world.set(c.pos, 'wheat', { age: 7 })
  bot.give('oak_planks', 4)
  const points = () => bot.inventory.items().filter(i => bot.registry.foodsByName[i.name]).reduce((n, i) => n + bot.registry.foodsByName[i.name].foodPoints * i.count, 0)
  const got = await foodFromFarm(bot, [job.record], { cancelled: false }, { foodPoints: points })
  assert.equal(bot.countOf('bread'), 3)
  assert.equal(got, 15)
})
