// The crafter role, no server needed:  node --test bridge/crew/test/crafter.test.js
//
// The planner on Mojang's 1.21.11 recipes, then whole jobs on the fake bot (test/mockbot.js) driven the way the
// game drives them: a raw chat line into Crew.handleChat, the mode manager ticked like physicsTick, and the item
// tossed to the player at the end. The fighter and the gatherer are stand-in modes here (the real ones need a server).

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { planCraft, parseCraftRequest, resolveTarget, describeMissing, TARGETS } = require('../skills/crafter_plan')
const { parseMessage } = require('../commands')
const { Mode } = require('../modes')
const { makeModes } = require('../behaviors')
const { Friends, Blackboard } = require('../targets')
const { Crew } = require('../crew')

const OWNER = 'Live_Fonam'
const bagOf = o => new Map(Object.entries(o))
const crafts = plan => plan.steps.filter(s => s.kind === 'craft').map(s => `${s.name} x${s.times}`)

// ---------- the planner ----------

test('demo plan: 1 oak log and 2 cobblestone by a table is exactly 1 cobblestone short of a stone pickaxe', () => {
  const plan = planCraft('stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 2 }), { tableNear: true })
  assert.deepEqual([...plan.missing], [['cobblestone', 1]])
  const full = planCraft('stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 3 }), { tableNear: true })
  assert.equal(full.missing.size, 0)
  assert.deepEqual(crafts(full), ['oak_planks x1', 'stick x1', 'stone_pickaxe x1'])
})

test('every supported item plans from raw materials with nothing missing', () => {
  const cases = {
    wooden_pickaxe: [{ oak_log: 2 }, ['oak_planks x2', 'stick x1', 'wooden_pickaxe x1']],
    stone_pickaxe: [{ oak_log: 1, cobblestone: 3 }, ['oak_planks x1', 'stick x1', 'stone_pickaxe x1']],
    iron_pickaxe: [{ oak_log: 1, iron_ingot: 3 }, ['oak_planks x1', 'stick x1', 'iron_pickaxe x1']],
    diamond_pickaxe: [{ oak_log: 1, diamond: 3 }, ['oak_planks x1', 'stick x1', 'diamond_pickaxe x1']],
    furnace: [{ cobblestone: 8 }, ['furnace x1']],
    crafting_table: [{ oak_log: 1 }, ['oak_planks x1', 'crafting_table x1']]
  }
  for (const t of TARGETS) {
    const [have, want] = cases[t]
    const plan = planCraft(t, bagOf(have), { tableNear: true })
    assert.equal(plan.missing.size, 0, `${t} missing ${describeMissing(plan.missing)}`)
    assert.deepEqual(crafts(plan), want, t)
    assert.equal(plan.steps.some(s => s.kind === 'smelt'), false, t)
  }
})

test('missing materials are exact for each item from an empty bag by a table', () => {
  const want = {
    wooden_pickaxe: [['oak_log', 2]],
    stone_pickaxe: [['cobblestone', 3], ['oak_log', 1]],
    diamond_pickaxe: [['diamond', 3], ['oak_log', 1]],
    furnace: [['cobblestone', 8]],
    crafting_table: [['oak_log', 1]]
  }
  for (const [t, m] of Object.entries(want)) {
    assert.deepEqual([...planCraft(t, new Map(), { tableNear: true }).missing].sort(), m.sort(), t)
  }
})

test('with no table in reach, the table and its wood are planned too', () => {
  // 4 planks for the table + 2 for the sticks = 6 planks = 2 logs
  const short = planCraft('stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 3 }), { tableNear: false })
  assert.deepEqual([...short.missing], [['oak_log', 1]])
  const plan = planCraft('stone_pickaxe', bagOf({ oak_log: 2, cobblestone: 3 }), { tableNear: false })
  assert.equal(plan.missing.size, 0)
  assert.deepEqual(crafts(plan), ['oak_planks x2', 'crafting_table x1', 'stick x1', 'stone_pickaxe x1'])
  assert.equal(plan.placeTable, true)
  // a table in the bag is placed instead of crafted
  const carried = planCraft('stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 3, crafting_table: 1 }), { tableNear: false })
  assert.deepEqual(crafts(carried), ['oak_planks x1', 'stick x1', 'stone_pickaxe x1'])
  // the 2 by 2 grid is enough for planks, sticks and the table itself
  assert.equal(planCraft('crafting_table', bagOf({ oak_log: 1 }), { tableNear: false }).placeTable, false)
})

test('other woods and stones work: spruce logs, cobbled deepslate', () => {
  const plan = planCraft('stone_pickaxe', bagOf({ spruce_log: 1, cobbled_deepslate: 3 }), { tableNear: true })
  assert.equal(plan.missing.size, 0)
  assert.deepEqual(crafts(plan), ['spruce_planks x1', 'stick x1', 'stone_pickaxe x1'])
})

test('iron pickaxe uses the ingots it carries first and smelts nothing then', () => {
  const plan = planCraft('iron_pickaxe', bagOf({ iron_ingot: 3, raw_iron: 5, oak_log: 1 }), { tableNear: true })
  assert.equal(plan.missing.size, 0)
  assert.equal(plan.steps.filter(s => s.kind === 'smelt').length, 0)
})

test('raw iron path: furnace from cobblestone, coal as fuel, only the ingots it lacks are smelted', () => {
  const plan = planCraft('iron_pickaxe', bagOf({ iron_ingot: 1, raw_iron: 5, coal: 1, cobblestone: 8, oak_log: 1 }), { tableNear: true })
  assert.equal(plan.missing.size, 0, describeMissing(plan.missing))
  const smelts = plan.steps.filter(s => s.kind === 'smelt')
  assert.equal(smelts.length, 1)
  assert.equal(smelts[0].input, 'raw_iron')
  assert.equal(smelts[0].count, 2)  // 1 ingot carried + 2 smelted = 3
  assert.deepEqual(smelts[0].fuel, [['coal', 1]])
  assert.equal(plan.placeFurnace, true)
  // the furnace is crafted before the smelt, the pickaxe after it
  const order = plan.steps.map(s => s.kind === 'smelt' ? 'smelt' : s.name)
  assert.ok(order.indexOf('furnace') < order.indexOf('smelt'))
  assert.ok(order.indexOf('smelt') < order.indexOf('iron_pickaxe'))
})

test('raw iron path: spare planks burn when there is no coal, a furnace in reach is used', () => {
  // 1 log = 4 planks: 2 for the sticks, 2 left burn 3 items
  const plan = planCraft('iron_pickaxe', bagOf({ raw_iron: 3, oak_log: 1 }), { tableNear: true, furnaceNear: true })
  assert.equal(plan.missing.size, 0, describeMissing(plan.missing))
  assert.deepEqual(plan.steps.find(s => s.kind === 'smelt').fuel, [['oak_planks', 2]])
  assert.equal(plan.placeFurnace, false)
  assert.equal(plan.steps.some(s => s.name === 'furnace'), false)
})

test('raw iron path: what it lacks for the furnace and the fuel is missing', () => {
  const plan = planCraft('iron_pickaxe', bagOf({ raw_iron: 3, stick: 2 }), { tableNear: true })
  assert.deepEqual([...plan.missing].sort(), [['coal', 1], ['cobblestone', 8]])
  const raw = planCraft('iron_pickaxe', bagOf({ stick: 2, coal: 1 }), { tableNear: true, furnaceNear: true })
  assert.deepEqual([...raw.missing], [['raw_iron', 3]])
})

test('craft requests in plain words and common names', () => {
  assert.deepEqual(parseCraftRequest('craft me a stone pickaxe'), { item: 'stone_pickaxe' })
  assert.deepEqual(parseCraftRequest('Craft a furnace.'), { item: 'furnace' })
  assert.deepEqual(parseCraftRequest('can you craft me a wood pickaxe please'), { item: 'wooden_pickaxe' })
  assert.deepEqual(parseCraftRequest('craft cobblestone pickaxe'), { item: 'stone_pickaxe' })
  assert.deepEqual(parseCraftRequest('make me an iron pickaxe'), { item: 'iron_pickaxe' })
  assert.deepEqual(parseCraftRequest('craft a diamond pick'), { item: 'diamond_pickaxe' })
  assert.deepEqual(parseCraftRequest('craft a crafting table'), { item: 'crafting_table' })
  assert.deepEqual(parseCraftRequest('craft me a workbench'), { item: 'crafting_table' })
  assert.ok(parseCraftRequest('craft a boat').error)
  assert.equal(parseCraftRequest('make a wheat farm'), null)  // not for the crafter
  assert.equal(parseCraftRequest('nice weather'), null)
  assert.equal(resolveTarget('stone_pickaxe'), 'stone_pickaxe')
})

test('chat lines become craft commands without the translator', () => {
  const names = ['Crew1']
  assert.deepEqual(parseMessage('craft me a stone pickaxe', names), { type: 'command', targets: 'all', command: { name: 'craft', args: { item: 'stone_pickaxe' } } })
  assert.equal(parseMessage('@crew craft a furnace', names).command.args.item, 'furnace')
  assert.deepEqual(parseMessage('Crew1, craft me a wood pickaxe', names).targets, ['Crew1'])
  assert.equal(parseMessage('!craft iron pickaxe', names).command.args.item, 'iron_pickaxe')
  assert.equal(parseMessage('!craft boat', names).type, 'error')
  assert.equal(parseMessage('@crew make a wheat farm', names).type, 'translate')
  assert.equal(parseMessage('hello there', names), null)
})

// ---------- whole jobs on the fake bot ----------

// A bot at 0 64 0 on flat grass, a crafting table 2 blocks away, the player 4 blocks away
function setup ({ inv = {}, table = true, player = true, gather = null, fighter = false } = {}) {
  const { bot, world } = makeBot({ groundY: 63 })
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  if (table) world.set(new Vec3(2, 64, 0), 'crafting_table')
  const crew = Object.create(Crew.prototype)
  Object.assign(crew, {
    owner: OWNER, names: ['Crew1'], ctxs: new Map(), friends: new Friends(OWNER, ['Crew1'], ['Friend2']),
    blackboard: new Blackboard(), verbosity: 'normal', lastAnnounce: { text: '', at: 0 }, lastEvent: new Map(), metricsFile: null, closing: false,
    log: () => {}
  })
  crew.noDigMoves = crew.digMoves = crew.buildMoves = () => ({})
  crew.ensureKit = async () => {}
  const ctx = { bot, crew, alive: true, seq: 0, pickaxes: null, human: { level: 'light' } }
  const m = makeModes(ctx)
  // stand-in roles at the priorities the real ones would have: the fighter above everything, the gatherer below craft
  const fight = new Fake('fight', 'fight')
  fight.always = true  // like guard: on all the time, wants control only when an enemy is close
  if (fighter) { m.modes.unshift(fight); m.byName.set('fight', fight) }
  if (gather) {
    const g = new Fake('gather', 'gather', gather)
    m.modes.splice(m.modes.indexOf(m.get('build')), 0, g)
    m.byName.set('gather', g)
  }
  crew.ctxs.set('Crew1', ctx)
  if (player) addPlayer(bot, OWNER, new Vec3(4.5, 64, 0.5))
  return { bot, world, crew, ctx, m, fight }
}

class Fake extends Mode {
  constructor (name, profile, onEnter = null) {
    super(name)
    this.profile = profile
    this.onEnter = onEnter
    this.want = true
    this.entered = 0
  }

  wants () { return this.want }
  enter () { this.entered++; if (this.onEnter) setTimeout(() => this.onEnter(this), 20) }
}

function addPlayer (bot, name, pos) {
  bot.players[name] = { username: name, entity: { type: 'player', username: name, position: pos, height: 1.8 } }
}

const chat = (crew, bot, text, sender = OWNER) => crew.handleChat(bot, `<${sender}> ${text}`)

// Ticks the manager like physicsTick until done() or the time runs out
async function tickUntil (m, done, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    m.tick()
    if (done()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

const said = (bot, re) => bot.chats.some(c => re.test(c))
const madeCount = (bot, name) => bot.crafted.filter(n => n === name).length
const gave = (bot, name) => bot.tossed.filter(t => t.name === name).reduce((n, t) => n + t.count, 0)

test('demo: chat "craft me a stone pickaxe", 1 cobblestone short, handed one, it finishes and gives it with no second command', async () => {
  const { bot, crew, m } = setup({ inv: { oak_log: 1, cobblestone: 2 } })
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(said(bot, /Crafting a stone pickaxe for Live_Fonam/))
  assert.ok(await tickUntil(m, () => said(bot, /need 1 cobblestone more/)), bot.chats.join(' | '))
  assert.equal(m.get('craft').job.phase, 'waiting')
  assert.equal(bot.crafted.length, 0)
  // waiting lets other modes run, and nothing happens until the block arrives
  await tickUntil(m, () => false, 300)
  assert.equal(bot.crafted.length, 0)
  bot.give('cobblestone', 1)  // the player hands it over
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1), bot.chats.join(' | '))
  assert.deepEqual(bot.crafted, ['oak_planks', 'stick', 'stone_pickaxe'])
  assert.ok(await tickUntil(m, () => said(bot, /Here's your stone pickaxe, Live_Fonam/), 3000))
  assert.equal(bot.countOf('stone_pickaxe'), 0)
  assert.equal(bot.countOf('cobblestone'), 0)
  // it walked to the player and dropped it there
  const t = bot.tossed[0]
  assert.ok(t.pos.distanceTo(bot.players[OWNER].entity.position) <= 3.5)
  await tickUntil(m, () => !m.get('craft').on, 1000)
  assert.equal(m.get('craft').on, false)
})

test('every supported item through chat: crafted once and handed over', async () => {
  const bags = {
    wooden_pickaxe: { oak_log: 2 },
    stone_pickaxe: { oak_log: 1, cobblestone: 3 },
    iron_pickaxe: { oak_log: 1, iron_ingot: 3 },
    diamond_pickaxe: { oak_log: 1, diamond: 3 },
    furnace: { cobblestone: 8 },
    crafting_table: { oak_log: 1 }
  }
  for (const [item, inv] of Object.entries(bags)) {
    const { bot, crew, m } = setup({ inv })
    await chat(crew, bot, `craft me a ${item.replace(/_/g, ' ')}`)
    assert.ok(await tickUntil(m, () => gave(bot, item) === 1), `${item}: ${bot.chats.join(' | ')}`)
    assert.equal(madeCount(bot, item), 1, item)
  }
})

test('raw iron through chat: crafts and places a furnace, smelts 3, checks the ingots, crafts, gives', async () => {
  const { bot, world, crew, m } = setup({ inv: { raw_iron: 3, coal: 1, cobblestone: 8, oak_log: 1 } })
  await chat(crew, bot, 'craft an iron pickaxe')
  assert.ok(await tickUntil(m, () => gave(bot, 'iron_pickaxe') === 1), bot.chats.join(' | '))
  assert.equal(madeCount(bot, 'furnace'), 1)
  assert.equal(madeCount(bot, 'iron_pickaxe'), 1)
  assert.ok(bot.placed.some(p => p.name === 'furnace'))
  assert.equal(bot.countOf('raw_iron'), 0)
  assert.equal(bot.countOf('coal'), 0)
  assert.equal(bot.countOf('iron_ingot'), 0)
  const f = [...world.furnaces.values()][0]
  assert.ok(!f.input && !f.output, 'nothing left in the furnace')
})

test('no table in reach: it crafts one, places it, uses it and picks it back up', async () => {
  const { bot, world, crew, m } = setup({ inv: { oak_log: 2, cobblestone: 3 }, table: false })
  await chat(crew, bot, 'craft me a cobblestone pickaxe')
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1), bot.chats.join(' | '))
  assert.ok(bot.placed.some(p => p.name === 'crafting_table'))
  assert.equal(bot.countOf('crafting_table'), 1)  // back in the bag
  assert.equal([...world.blocks.values()].some(b => b.name === 'crafting_table'), false)
})

test('the gatherer role gets the exact missing materials, and the job resumes when it is done', async () => {
  let order = null
  const { bot, crew, m } = setup({
    inv: { oak_log: 1, cobblestone: 2 },
    gather: mode => {
      order = mode.params
      for (const { name, count } of mode.params.items) bot.give(name, count)
      mode.finish('done')
    }
  })
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1), bot.chats.join(' | '))
  assert.deepEqual(order.items, [{ name: 'cobblestone', count: 1 }])
  assert.equal(order.for, 'craft')
  assert.equal(order.requester, OWNER)
  assert.ok(said(bot, /I need 1 cobblestone, gathering it/))
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('a gatherer that fails twice hands the ask to the player', async () => {
  const { bot, crew, m } = setup({ inv: { oak_log: 1, cobblestone: 2 }, gather: mode => mode.finish('error') })
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /gatherer couldn't get it all/)), bot.chats.join(' | '))
  assert.equal(m.get('gather').entered, 2)
  bot.give('cobblestone', 1)
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1))
})

test('the fighter cuts in mid job: craft gives up control, then resumes from the bag and makes only one', async () => {
  const { bot, crew, m, fight } = setup({ inv: { oak_log: 1, cobblestone: 3 }, fighter: true })
  fight.want = false
  // slow crafting so the fight lands in the middle of the job
  const craft = bot.craft
  bot.craft = async (...a) => { await new Promise(resolve => setTimeout(resolve, 150)); return craft(...a) }
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(await tickUntil(m, () => bot.crafted.includes('oak_planks')))
  fight.want = true  // a zombie
  m.tick()
  assert.equal(m.active, fight)
  assert.equal(m.get('craft').token, null, 'the craft run is cancelled')
  const during = bot.crafted.length
  await tickUntil(m, () => false, 600)
  assert.ok(bot.crafted.length <= during + 1, 'at most the craft already on its way lands')
  assert.equal(m.active, fight, 'only the fighter has control')
  fight.want = false  // the zombie is dead
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1), bot.chats.join(' | '))
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.equal(madeCount(bot, 'stick'), 1)
})

test('a fight that lands just as the pickaxe is crafted does not make a second one', async () => {
  const { bot, crew, m, fight } = setup({ inv: { oak_log: 1, cobblestone: 3 }, fighter: true })
  fight.want = false
  const craft = bot.craft
  bot.craft = async (recipe, ...a) => {
    const r = await craft(recipe, ...a)
    if (bot.registry.items[recipe.result.id].name === 'stone_pickaxe') fight.want = true  // right after the final craft
    return r
  }
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(await tickUntil(m, () => m.active === fight))
  fight.want = false
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1))
  await tickUntil(m, () => false, 300)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.equal(gave(bot, 'stone_pickaxe'), 1)
})

test('asking again while it waits is not a second job', async () => {
  const { bot, crew, m } = setup({ inv: { oak_log: 1, cobblestone: 2 } })
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(await tickUntil(m, () => m.get('craft').job?.phase === 'waiting'))
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(said(bot, /already on your stone pickaxe/))
  assert.equal(m.get('craft').queue.length, 0)
  bot.give('cobblestone', 1)
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1))
  await tickUntil(m, () => false, 300)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('player out of reach: it keeps the item, says it is ready, and hands it over when they come back', async () => {
  const { bot, crew, m } = setup({ inv: { oak_log: 1, cobblestone: 3 } })
  await chat(crew, bot, 'craft me a stone pickaxe')
  delete bot.players[OWNER]  // walked off out of sight
  assert.ok(await tickUntil(m, () => said(bot, /your stone pickaxe is ready, I'm keeping it/)), bot.chats.join(' | '))
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  assert.equal(m.get('craft').job.phase, 'holding')
  addPlayer(bot, OWNER, new Vec3(5.5, 64, 2.5))
  m.get('craft').job.retryAt = 0
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1), bot.chats.join(' | '))
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('asking again while it holds the item hands that one over, it crafts no second', async () => {
  const { bot, crew, m } = setup({ inv: { oak_log: 1, cobblestone: 3 } })
  await chat(crew, bot, 'craft me a stone pickaxe')
  delete bot.players[OWNER]
  assert.ok(await tickUntil(m, () => m.get('craft').job?.phase === 'holding'))
  addPlayer(bot, OWNER, new Vec3(4.5, 64, 0.5))
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(said(bot, /is ready, Live_Fonam, bringing it/))
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1))
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('it keeps its own pickaxe and makes a new one for the player', async () => {
  const { bot, crew, m } = setup({ inv: { stone_pickaxe: 1, oak_log: 1, cobblestone: 3 } })
  await chat(crew, bot, 'craft me a stone pickaxe')
  assert.ok(await tickUntil(m, () => gave(bot, 'stone_pickaxe') === 1))
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
})

test('a friend can ask the crafter and gets the item; a stranger is ignored', async () => {
  const { bot, crew, m } = setup({ inv: { cobblestone: 8 } })
  addPlayer(bot, 'Friend2', new Vec3(-3.5, 64, 0.5))
  await chat(crew, bot, 'craft a furnace', 'Stranger')
  assert.equal(m.get('craft').job, null)
  await chat(crew, bot, 'craft a furnace', 'Friend2')
  assert.ok(await tickUntil(m, () => gave(bot, 'furnace') === 1))
  assert.ok(bot.tossed[0].pos.distanceTo(bot.players.Friend2.entity.position) <= 3.5)
  assert.ok(await tickUntil(m, () => said(bot, /Here's your furnace, Friend2/), 3000))
})

test('a second request queues behind the first, and !stop ends both', async () => {
  const { bot, crew, m } = setup({ inv: { oak_log: 1 } })
  await chat(crew, bot, 'craft me a stone pickaxe')
  await chat(crew, bot, 'craft a furnace')
  assert.equal(m.get('craft').queue.length, 1)
  assert.ok(said(bot, /I'll craft the furnace/))
  await chat(crew, bot, '!stop')
  assert.equal(m.get('craft').job, null)
  assert.equal(m.get('craft').queue.length, 0)
  assert.equal(m.get('craft').on, false)
})
