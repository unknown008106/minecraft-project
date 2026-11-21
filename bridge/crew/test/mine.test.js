// Mining tests on the fake world (test/mockbot.js), no server needed:  node --test bridge/crew/test/*.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { mineJob } = require('../skills/mine')
const { BEST_Y, haulFilter, targetDepth } = require('../skills/mine_branch')

const FALL = new Set(['gravel', 'sand'])

// A human with no pauses and a torch every 3 blocks, so the tests run fast and the same way every time
const human = {
  level: 'off',
  placesTorches: true,
  nextTorchGap: () => 3,
  idleMoment: async () => {},
  lookAtPoint: async () => {},
  lookAround: async () => {},
  detourPoint: () => null
}

// The fake world with a start cell carved out, a raycast for the pathfinder's look goal, falling gravel, a dig limit
// and a record of every cell the bot stood in
function setup ({ at = new Vec3(0, 16, 0), digLimit = 200, give = [['diamond_pickaxe', 1]], dropCobble = false } = {}) {
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  world.set(at, 'air')
  world.set(at.offset(0, 1, 0), 'air')
  for (const [name, n] of give) bot.give(name, n)
  const token = { cancelled: false }
  const digs = []
  const dig = bot.dig
  bot.dig = async (block, ...rest) => {
    const pos = block.position.clone()
    const name = world.name(pos)
    await dig(block, ...rest)
    digs.push({ pos, name })
    // gravel and sand above the hole come down at once, each to the lowest open cell under it
    for (let y = pos.y; y < pos.y + 12; y++) {
      const c = new Vec3(pos.x, y, pos.z)
      const n = world.name(c)
      if (!FALL.has(n)) continue
      let land = c
      while (world.name(land.offset(0, -1, 0)) === 'air' && land.y > pos.y - 6) land = land.offset(0, -1, 0)
      if (!land.equals(c)) {
        world.set(c, 'air')
        world.set(land, n)
      }
    }
    if (dropCobble) bot.take('cobblestone', 64)
    if (digs.length >= digLimit) token.cancelled = true
  }
  const stood = []
  const ticks = bot.waitForTicks
  bot.waitForTicks = async (n) => {
    await ticks(n)
    const f = bot.entity.position.floored()
    stood.push({ feet: f, head: world.name(f.offset(0, 1, 0)), inFeet: world.name(f) })
  }
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  return { bot, world, token, digs, stood }
}

const job = (block, blocks, extra = {}) => ({ block, blocks, count: 1, mined: 0, strategy: 'new', home: null, ...extra })
const DIAMOND = ['diamond_ore', 'deepslate_diamond_ore']
const IRON = ['iron_ore', 'deepslate_iron_ore']
const open = (world, x, y, z) => world.name(new Vec3(x, y, z)) === 'air'

test('1.21 depths from the wiki, and the depth it aims for', () => {
  assert.equal(BEST_Y.diamond, -58)
  assert.equal(BEST_Y.iron, 16)
  assert.equal(BEST_Y.copper, 48)
  assert.equal(BEST_Y.coal, 96)
  assert.equal(BEST_Y.gold, -16)
  assert.equal(BEST_Y.lapis, 0)
  // from the surface: down to iron's 16, coal just under the surface since 96 is above it, never a climb
  const { bot } = makeBot({ groundY: 63 })
  assert.equal(targetDepth(bot, 'iron'), 16)
  assert.equal(targetDepth(bot, 'coal'), 58)
  assert.equal(targetDepth(bot, 'diamond'), -58)
  const deep = makeBot({ groundY: 63, pos: new Vec3(0.5, -20, 0.5) }).bot
  assert.equal(targetDepth(deep, 'iron'), -20)
})

test('branch mining: a main tunnel with branches to both sides every 3 blocks, 2 solid blocks between', async () => {
  const { bot, world, token } = setup({ at: new Vec3(0, -58, 0), digLimit: 140 })
  const j = job('diamond', DIAMOND, { tuning: { branchLen: 4 } })
  const r = await mineJob(bot, j, human, token, {})
  assert.equal(r.result, 'cancelled')
  const y = -58
  // the main tunnel runs north (yaw 0) from the start
  let len = 0
  while (open(world, 0, y, -(len + 1))) len++
  assert.ok(len >= 7, `main tunnel only ${len} long`)
  for (let s = 0; s <= len; s++) {
    const z = -s
    const branched = open(world, 1, y, z) || open(world, -1, y, z)
    if (s % 3 === 0 && s < len) {
      for (let k = 1; k <= 4; k++) {
        assert.ok(open(world, k, y, z) && open(world, k, y + 1, z), `east branch at ${z} cell ${k}`)
        assert.ok(open(world, -k, y, z) && open(world, -k, y + 1, z), `west branch at ${z} cell ${k}`)
      }
      assert.ok(!open(world, 5, y, z) && !open(world, -5, y, z), 'branches stop at their length')
    } else if (s % 3 !== 0) {
      assert.ok(!branched, `no branch at ${z}`)
    }
  }
  assert.ok(j.stats.dug >= 100, `dug ${j.stats.dug}`)
  assert.ok(j.stats.branches >= 4)
  assert.equal(j.stats.strategy, 'new')
})

test('ore in a branch wall is found once its face opens, mined, and the haul goes into the chest at home', async () => {
  const { bot, world, token, digs } = setup({ at: new Vec3(0, -58, 0), digLimit: 400 })
  const ore = new Vec3(3, -57, -2)
  world.set(ore, 'deepslate_diamond_ore')
  world.fillChest(new Vec3(0, -58, 1), [])
  const j = job('diamond', DIAMOND, { tuning: { branchLen: 4 } })
  const r = await mineJob(bot, j, human, token, {})
  assert.equal(r.result, 'done', r.message)
  assert.equal(j.mined, 1)
  assert.equal(j.stats.ores, 1)
  // it saw the ore only after the branch beside it opened its face: no X-ray
  const oreAt = digs.findIndex(d => d.pos.equals(ore))
  const faceAt = digs.findIndex(d => d.pos.equals(new Vec3(3, -57, -3)))
  assert.ok(faceAt >= 0 && faceAt < oreAt, `face opened at ${faceAt}, ore dug at ${oreAt}`)
  // home and the chest
  assert.match(r.message, /put \d+ items in the chest/)
  const inside = world.containers.get('0,-58,1')
  assert.ok(inside.some(i => i.name === 'diamond' && i.count === 1))
  assert.equal(bot.countOf('diamond'), 0)
  assert.ok(bot.countOf('diamond_pickaxe') === 1, 'keeps its pickaxe')
  assert.ok(bot.countOf('cobblestone') <= 64 && bot.countOf('cobblestone') >= 32, 'keeps some cobblestone for blocking')
  assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, -58, 0.5)) <= 4, 'back home')
})

test('a full bag goes home into the chest, then back down to finish the job', async () => {
  const { bot, world, token } = setup({ at: new Vec3(0, -58, 0), digLimit: 400 })
  for (let i = 0; i < 34; i++) bot.give('flint', 64)
  assert.equal(bot.inventory.emptySlotCount(), 1)
  world.set(new Vec3(3, -57, -2), 'deepslate_diamond_ore')
  world.fillChest(new Vec3(0, -58, 1), [])
  const said = []
  const j = job('diamond', DIAMOND, { tuning: { branchLen: 4 } })
  const r = await mineJob(bot, j, human, token, { say: t => said.push(t) })
  assert.equal(r.result, 'done', r.message)
  const inside = world.containers.get('0,-58,1')
  assert.ok(inside.some(i => i.name === 'flint' && i.count === 34 * 64), 'flint stored')
  assert.ok(inside.some(i => i.name === 'diamond'), 'the diamond found after the trip home is stored too')
  assert.ok(said.some(t => /going back down/.test(t)))
  assert.ok(j.stats.stored >= 34 * 64)
})

test('job.store false walks home and keeps the haul', async () => {
  const { bot, world, token } = setup({ at: new Vec3(0, -58, 0), digLimit: 400 })
  world.set(new Vec3(3, -57, -2), 'deepslate_diamond_ore')
  world.fillChest(new Vec3(0, -58, 1), [])
  const j = job('diamond', DIAMOND, { tuning: { branchLen: 4 }, store: false })
  const r = await mineJob(bot, j, human, token, {})
  assert.equal(r.result, 'done')
  assert.equal(bot.countOf('diamond'), 1)
  assert.equal(world.containers.get('0,-58,1').length, 0)
  assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, -58, 0.5)) <= 4)
})

test('lava behind the next wall turns the tunnel, lava under the next step gets a block', async () => {
  let t = setup({ digLimit: 12 })
  t.world.set(new Vec3(0, 16, -2), 'lava', { level: 0 })
  let j = job('iron', IRON, { tuning: { branchLen: 0 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.ok(j.stats.lavaBlocked >= 1)
  assert.equal(t.world.name(new Vec3(0, 16, -1)), 'stone', 'the wall next to the lava stays shut')
  assert.equal(t.world.name(new Vec3(0, 16, -2)), 'lava')
  assert.ok(t.stood.every(s => s.feet.distanceTo(new Vec3(0, 16, -2)) > 1.5), 'never next to the lava')

  t = setup({ digLimit: 3, give: [['diamond_pickaxe', 1], ['cobblestone', 8]] })
  t.world.set(new Vec3(0, 15, -1), 'lava', { level: 0 })
  j = job('iron', IRON, { tuning: { branchLen: 0 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.equal(t.world.name(new Vec3(0, 15, -1)), 'cobblestone')
  assert.ok(j.stats.lavaBlocked >= 1)
  assert.ok(t.stood.some(s => s.feet.equals(new Vec3(0, 16, -1))), 'stepped on the new block')
})

test('never steps into a drop of 5 blocks without a block to bridge it, takes a drop of 2, bridges with a block', async () => {
  let t = setup({ digLimit: 12, dropCobble: true })
  for (let y = 11; y <= 15; y++) t.world.set(new Vec3(0, y, -1), 'air')
  let j = job('iron', IRON, { tuning: { branchLen: 0 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.ok(t.stood.every(s => s.feet.y >= 16), 'fell into the hole')
  assert.ok(j.stats.turns >= 1)

  // a drop of 2 is taken when it has no block, and the tunnel goes on from the bottom
  t = setup({ digLimit: 8, dropCobble: true })
  for (let y = 14; y <= 15; y++) t.world.set(new Vec3(0, y, -1), 'air')
  j = job('iron', IRON, { tuning: { branchLen: 0 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.ok(t.stood.some(s => s.feet.equals(new Vec3(0, 14, -1))), 'stepped down the small drop')
  assert.ok(t.stood.every(s => s.feet.y >= 14))
  assert.equal(j.stats.stuck, 0)

  t = setup({ digLimit: 6, give: [['diamond_pickaxe', 1], ['cobblestone', 8]] })
  for (let y = 11; y <= 15; y++) t.world.set(new Vec3(0, y, -1), 'air')
  j = job('iron', IRON, { tuning: { branchLen: 0 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.equal(t.world.name(new Vec3(0, 15, -1)), 'cobblestone')
  assert.ok(t.stood.every(s => s.feet.y >= 16))
  assert.ok(t.stood.some(s => s.feet.equals(new Vec3(0, 16, -1))))
})

test('gravel over the next step is dug out before it steps under it', async () => {
  const t = setup({ digLimit: 5 })
  for (let y = 18; y <= 20; y++) t.world.set(new Vec3(0, y, -1), 'gravel')
  const j = job('iron', IRON, { tuning: { branchLen: 0 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.equal(t.digs.filter(d => d.name === 'gravel').length, 3)
  for (let y = 16; y <= 20; y++) assert.equal(t.world.name(new Vec3(0, y, -1)), 'air')
  assert.ok(t.stood.every(s => s.head !== 'gravel' && s.inFeet !== 'gravel'), 'never under or in gravel')
})

test('torches go on the right hand wall going in', async () => {
  const t = setup({ digLimit: 20, give: [['diamond_pickaxe', 1], ['torch', 16]] })
  const j = job('diamond', DIAMOND, { tuning: { branchLen: 0 } })
  t.bot.entity.position = new Vec3(0.5, -58, 0.5)
  t.world.set(new Vec3(0, -58, 0), 'air')
  t.world.set(new Vec3(0, -57, 0), 'air')
  await mineJob(t.bot, j, human, t.token, {})
  const torches = t.bot.placed.filter(p => p.name === 'wall_torch')
  assert.ok(torches.length >= 2, `${torches.length} torches`)
  for (const p of torches) {
    // going north the right hand wall is east, so the torch hangs on it facing west
    assert.equal(p.props.facing, 'west')
    assert.equal(p.pos.x, 0)
    assert.equal(t.world.name(p.pos.offset(1, 0, 0)), 'stone')
  }
  assert.equal(j.stats.torches, torches.length)
})

test('caving: follows a cave it can see and mines the iron around the corner', async () => {
  const t = setup({ digLimit: 60 })
  for (let z = -1; z >= -10; z--) {
    t.world.set(new Vec3(0, 16, z), 'air')
    t.world.set(new Vec3(0, 17, z), 'air')
  }
  for (let x = 1; x <= 8; x++) {
    t.world.set(new Vec3(x, 16, -10), 'air')
    t.world.set(new Vec3(x, 17, -10), 'air')
  }
  t.world.set(new Vec3(9, 17, -10), 'iron_ore')
  const j = job('iron', IRON)
  const r = await mineJob(t.bot, j, human, t.token, {})
  assert.equal(r.result, 'done', r.message)
  assert.equal(t.bot.countOf('raw_iron'), 1)
  assert.ok(j.stats.caveMoves >= 1)
  assert.match(r.message, /no chest at home so I kept it/)
})

test('the old strategy still runs and finds ore within 4 blocks, the new one never sees buried ore', async () => {
  const t = setup({ at: new Vec3(0, 64, 0), digLimit: 50, give: [['stone_pickaxe', 1]] })
  t.world.set(new Vec3(1, 62, 0), 'iron_ore')
  const j = job('iron', IRON, { strategy: 'old' })
  const r = await mineJob(t.bot, j, human, t.token, {})
  assert.equal(r.result, 'done', r.message)
  assert.equal(j.stats.strategy, 'old')
  assert.equal(j.stats.mode, 'tunnel')
  assert.equal(j.stats.ores, 1)
  assert.ok(j.stats.dug >= 1)
  assert.equal(t.bot.countOf('raw_iron'), 1)

  const n = setup({ at: new Vec3(0, 64, 0), digLimit: 9, give: [['stone_pickaxe', 1]] })
  n.world.set(new Vec3(1, 62, 0), 'iron_ore')
  const k = job('iron', IRON)
  await mineJob(n.bot, k, human, n.token, {})
  assert.equal(k.mined, 0)
  assert.equal(n.world.name(new Vec3(1, 62, 0)), 'iron_ore')
})

test('the haul keeps tools, torches, food and 32 blocks', () => {
  const { bot } = makeBot()
  bot.give('iron_pickaxe', 1)
  bot.give('torch', 10)
  bot.give('bread', 5)
  bot.give('cobblestone', 64)
  bot.give('cobblestone', 64)
  bot.give('raw_iron', 7)
  bot.give('water_bucket', 1)
  const f = haulFilter(bot)
  const goes = bot.inventory.items().filter(f)
  assert.deepEqual(goes.map(i => `${i.name} ${i.count}`).sort(), ['cobblestone 64', 'raw_iron 7'])
})

test('a broken pickaxe: a new stone one from cobblestone and 2 logs, else the job ends', async () => {
  const { makeBot } = require('./mockbot')
  const { hasHarvestTool, replacePickaxe } = require('../skills/mine_branch')
  const { bot } = makeBot()
  const job = { blocks: ['iron_ore', 'deepslate_iron_ore'] }
  assert.equal(hasHarvestTool(bot, job), false)
  bot.give('stone_pickaxe', 1)
  assert.equal(hasHarvestTool(bot, job), true)
  bot.take('stone_pickaxe', 1)
  const said = []
  const ctx = { say: t => said.push(t), log: () => {} }
  // no wood: no new pickaxe
  bot.give('cobblestone', 10)
  assert.equal(await replacePickaxe(bot, ctx, { cancelled: false }), false)
  // 2 logs: planks, a crafting table, sticks, the pickaxe, and the table back in the bag
  bot.give('oak_log', 2)
  assert.equal(await replacePickaxe(bot, ctx, { cancelled: false }), true)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.equal(bot.countOf('cobblestone'), 7)
  assert.ok(said.some(t => /made a new stone one/.test(t)))
})
