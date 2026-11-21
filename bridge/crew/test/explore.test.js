// Explore skill tests with the fake world, no server needed:  node --test bridge/crew/test/*.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { exploreJob, spiral, cellsOnLine } = require('../skills/explore')

const human = { level: 'off', idleMoment: async () => {}, lookAround: async () => {} }
const token = () => ({ cancelled: false })

// A fake bot whose every walk is recorded, plus the chat lines it says
function setup () {
  const { bot, world } = makeBot({ groundY: 63 })
  const said = []
  const positions = []
  const goto = bot.pathfinder.goto
  const hooks = { before: null, after: null }
  let calls = 0
  bot.pathfinder.goto = async goal => {
    calls++
    if (hooks.before) hooks.before(calls)
    await goto(goal)
    positions.push(bot.entity.position.clone())
    if (hooks.after) hooks.after(calls)
  }
  const opts = { say: text => said.push(text), log: () => {} }
  return { bot, world, said, positions, hooks, opts }
}

// Fake mobs the way Mineflayer lists them in bot.entities
let nextId = 100
function mob (bot, name, x, y, z, height = 1.4) {
  const e = { id: nextId++, name, type: 'animal', position: new Vec3(x, y, z), height, isValid: true }
  bot.entities[e.id] = e
  return e
}

test('the waypoints stay inside the radius and start where it faces', () => {
  const start = new Vec3(100.5, 64, -20.5)
  for (const radius of [8, 16, 32, 64, 128]) {
    const wps = spiral(start, radius, 0)
    assert.ok(wps.length >= 6)
    for (const p of wps) assert.ok(Math.hypot(p.x - start.x, p.z - start.z) <= radius - 3, `${p} outside ${radius}`)
  }
  // yaw 0 looks at -z, so the first waypoint lies north of the start
  const first = spiral(start, 32, 0)[0]
  assert.ok(first.z < start.z - 5 && Math.abs(first.x - start.x) < 2)
})

test('the line walk visits every cell between two points', () => {
  const cells = cellsOnLine(new Vec3(0.5, 0.5, 0.5), new Vec3(3.5, 0.5, 2.5))
  assert.deepEqual(cells[0].toArray(), [0, 0, 0])
  assert.deepEqual(cells[cells.length - 1].toArray(), [3, 0, 2])
  for (let i = 1; i < cells.length; i++) assert.equal(cells[i].distanceTo(cells[i - 1]), 1)
})

test('an exposed ore in sight is reported, one behind a wall is not', async () => {
  const { bot, world, said, opts } = setup()
  world.set(new Vec3(6, 64, 0), 'iron_ore')    // sticks out of the ground in plain view
  world.set(new Vec3(-6, 58, 0), 'gold_ore')   // open only to a sealed pocket underground
  world.set(new Vec3(-6, 59, 0), 'air')
  const job = { radius: 20 }
  const r = await exploreJob(bot, job, human, token(), opts)
  assert.equal(r.result, 'done')
  assert.equal(said.filter(t => /iron/.test(t)).length, 1)
  assert.ok(said.some(t => t === 'Exposed iron ore at 6 64 0'))
  assert.equal(said.filter(t => /gold/.test(t)).length, 0)
  assert.ok(!job.found.some(f => f.label === 'gold'))
})

test('animals in sight are counted once each, hidden ones are not', async () => {
  const { bot, world, said, opts } = setup()
  for (const x of [4.5, 5.5, 6.5]) mob(bot, 'cow', x, 64, 3.5)
  mob(bot, 'sheep', 4.5, 64, -3.5, 1.3)
  mob(bot, 'sheep', 5.5, 64, -4.5, 1.3)
  // a cow shut in a stone box
  world.fill3(new Vec3(-12, 64, -12), new Vec3(-10, 67, -10), 'stone')
  world.fill3(new Vec3(-11, 64, -11), new Vec3(-11, 66, -11), 'air')
  mob(bot, 'cow', -10.5, 64, -10.5)
  const job = { radius: 20 }
  await exploreJob(bot, job, human, token(), opts)
  const lines = said.filter(t => t.startsWith('Animals for food'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /: 3 cows, 2 sheep$/)
  assert.equal(job.found.find(f => f.kind === 'animals').count, 5)
  assert.match(job.ctx.message || '', /5 animals for food/)
})

test('a village from a bell and from 3 village blocks, each said once', async () => {
  let s = setup()
  s.world.set(new Vec3(5, 64, 5), 'bell')
  await exploreJob(s.bot, { radius: 16 }, human, token(), s.opts)
  assert.deepEqual(s.said.filter(t => t.startsWith('Village')), ['Village at 5 64 5 (a bell)'])

  s = setup()
  s.world.set(new Vec3(5, 64, -6), 'hay_block')
  s.world.set(new Vec3(7, 64, -5), 'composter')
  s.world.set(new Vec3(6, 64, -8), 'lectern', { facing: 'north', has_book: false, powered: false })
  await exploreJob(s.bot, { radius: 16 }, human, token(), s.opts)
  const v = s.said.filter(t => t.startsWith('Village'))
  assert.equal(v.length, 1)
  assert.match(v[0], /\(village blocks\)$/)
})

test('a cave entrance it can see is reported once and it looks inside', async () => {
  const { bot, world, said, opts } = setup()
  world.fill3(new Vec3(6, 60, -3), new Vec3(12, 62, 3), 'air')   // a room under the grass
  world.fill3(new Vec3(7, 63, -1), new Vec3(9, 63, 1), 'air')    // its opening
  const job = { radius: 20 }
  const r = await exploreJob(bot, job, human, token(), opts)
  assert.equal(r.result, 'done')
  const caves = said.filter(t => t.startsWith('Cave entrance'))
  assert.equal(caves.length, 1)
  const [x, y] = caves[0].replace('Cave entrance at ', '').split(' ').map(Number)
  assert.ok(x >= 6 && x <= 12 && y >= 60 && y <= 62, caves[0])
  assert.equal(job.stats.peeks, 1)
})

test('it keeps inside the radius and comes back to the start', async () => {
  const { bot, positions, opts } = setup()
  const start = bot.entity.position.clone()
  const job = { radius: 20 }
  const r = await exploreJob(bot, job, human, token(), opts)
  assert.equal(r.result, 'done')
  assert.match(r.message, /^Back from exploring 20 blocks: nothing worth noting$/)
  assert.ok(positions.length > 10)
  for (const p of positions) assert.ok(p.distanceTo(start) <= 20, `walked to ${p}`)
  assert.ok(bot.entity.position.distanceTo(start) <= 4)
  assert.ok(job.stats.walked > 0 && job.stats.endedAt >= job.stats.startedAt)
  assert.equal(job.stats.reached, job.ctx.waypoints.length)
})

test('an unreachable waypoint is skipped, and a fight pause carries on where it was', async () => {
  const { bot, world, said, hooks, opts } = setup()
  world.set(new Vec3(6, 64, 0), 'iron_ore')
  const t1 = token()
  hooks.before = n => { if (n === 2 || n === 3) throw new Error('No path to the goal!') }
  hooks.after = n => { if (n === 5) t1.cancelled = true }
  const job = { radius: 20 }
  const r1 = await exploreJob(bot, job, human, t1, opts)
  assert.equal(r1.result, 'cancelled')
  assert.equal(job.stats.failed, 2)
  const at = job.ctx.index
  hooks.before = null
  hooks.after = null
  const r2 = await exploreJob(bot, job, human, token(), opts)
  assert.equal(r2.result, 'done')
  assert.ok(job.ctx.index >= at)
  assert.equal(said.filter(t => /iron/.test(t)).length, 1)
  assert.equal(job.stats.reached + job.stats.failed, job.ctx.waypoints.length)
})

test('it heads back early when it keeps getting stuck, and stops on the time cap', async () => {
  let s = setup()
  s.hooks.before = n => { if (n <= 8) throw new Error('No path to the goal!') }
  let r = await exploreJob(s.bot, { radius: 32 }, human, token(), s.opts)
  assert.equal(r.result, 'stuck')
  assert.match(r.message, /^Back early, I kept getting stuck/)

  s = setup()
  let clock = 0
  s.hooks.after = () => { clock += 60000 }
  const job = { radius: 64 }
  r = await exploreJob(s.bot, job, human, token(), { ...s.opts, now: () => clock, capMs: 180000 })
  assert.equal(r.result, 'done')
  assert.ok(job.stats.reached <= 4 && job.ctx.stop === 'time', `reached ${job.stats.reached}`)
})
