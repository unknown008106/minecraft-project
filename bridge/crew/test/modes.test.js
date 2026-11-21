// Mode manager and targeting tests, no server needed:  node --test bridge/crew/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Mode, ModeManager } = require('../modes')
const { Friends, enemiesNear, pickFocus, friendInTheWay, isEnemy } = require('../targets')

class Fake extends Mode {
  constructor (name, log) {
    super(name)
    this.log = log
    this.want = true
  }
  wants () { return this.want }
  enter () { this.log.push(`enter ${this.name}`) }
  exit () { this.log.push(`exit ${this.name}`) }
}

function setup () {
  const log = []
  const kill = new Fake('kill', log)
  const mine = new Fake('mine', log)
  const idle = new Fake('idle', log)
  idle.always = true
  let stops = 0
  const m = new ModeManager([kill, mine, idle], { stopAll: () => { stops++ } })
  return { m, kill, mine, idle, log, stops: () => stops }
}

test('the highest mode that is on and wants control runs', () => {
  const { m, mine, kill } = setup()
  m.tick()
  assert.equal(m.active.name, 'idle')
  m.setOn('mine', { block: 'coal' })
  m.tick()
  assert.equal(m.active, mine)
  m.setOn('kill', { radius: 50 })
  m.tick()
  assert.equal(m.active, kill)
})

test('a fight pauses the job and the job comes back after', () => {
  const { m, kill, mine, log } = setup()
  m.setOn('mine', {})
  m.tick()
  m.setOn('kill', {})
  m.tick()
  assert.deepEqual(log.slice(-2), ['exit mine', 'enter kill'])
  kill.want = false
  m.tick()
  assert.equal(m.active, mine)
  assert.ok(mine.on)
  assert.equal(log[log.length - 1], 'enter mine')
})

test('stop always wins, ends every job and clears the keys', async () => {
  const { m, kill, mine, stops } = setup()
  const job = m.setOn('mine', {})
  const fight = m.setOn('kill', {})
  m.tick()
  m.requestStop()
  m.tick()
  assert.equal(await job, 'stopped')
  assert.equal(await fight, 'stopped')
  assert.equal(kill.on, false)
  assert.equal(mine.on, false)
  assert.equal(m.active, null)
  assert.equal(stops(), 1)
  m.tick()
  assert.equal(m.active.name, 'idle')
})

test('a job that finishes settles its promise and hands control down', async () => {
  const { m, mine } = setup()
  const job = m.setOn('mine', {})
  m.tick()
  mine.finish('done')
  m.tick()
  assert.equal(await job, 'done')
  assert.equal(m.active.name, 'idle')
})

test('a new order for the running mode restarts it', () => {
  const { m, mine, log } = setup()
  m.setOn('mine', { count: 1 })
  m.tick()
  m.setOn('mine', { count: 9 })
  m.tick()
  assert.deepEqual(log.slice(-2), ['exit mine', 'enter mine'])
  assert.equal(mine.params.count, 9)
})

test('a broken mode does not take the manager down', () => {
  const { m, mine } = setup()
  mine.wants = () => { throw new Error('boom') }
  m.setOn('mine', {})
  m.tick()
  assert.equal(m.active.name, 'idle')
})

const at = (x, y, z) => ({ x, y, z })
const player = (id, username, pos) => ({ id, type: 'player', username, position: pos, height: 1.8 })
const mob = (id, name, type, pos) => ({ id, name, type, position: pos, height: 1.95 })

test('friends are never enemies, animals are left alone', () => {
  const f = new Friends('Live_Fonam', ['Crew1', 'Crew2'], ['Pal'])
  assert.equal(isEnemy(player(1, 'live_fonam', at(0, 0, 0)), f), false)
  assert.equal(isEnemy(player(2, 'Crew2', at(0, 0, 0)), f), false)
  assert.equal(isEnemy(player(3, 'Pal', at(0, 0, 0)), f), false)
  assert.equal(isEnemy(player(4, 'Eve', at(0, 0, 0)), f), true)
  assert.equal(isEnemy(mob(5, 'zombie', 'hostile', at(0, 0, 0)), f), true)
  assert.equal(isEnemy(mob(6, 'cow', 'animal', at(0, 0, 0)), f), false)
})

test('enemies within the radius, nearest first, and one shared focus', () => {
  const f = new Friends('Live_Fonam', ['Crew1', 'Crew2'])
  const ents = {
    1: player(1, 'Live_Fonam', at(0, 64, 0)),
    2: player(2, 'Eve', at(30, 64, 0)),
    3: mob(3, 'zombie', 'hostile', at(10, 64, 0)),
    4: player(4, 'Mallory', at(80, 64, 0)),
    5: player(5, 'Crew2', at(2, 64, 0))
  }
  const list = enemiesNear(ents, at(0, 64, 0), 50, f)
  assert.deepEqual(list.map(e => e.id), [3, 2])
  // nearest to the owner
  assert.equal(pickFocus(list, at(0, 64, 0), null, null).id, 3)
  // the current focus sticks while it is in range
  assert.equal(pickFocus(list, at(0, 64, 0), null, 2).id, 2)
  // the owner's named target wins, and a missing name gives nobody
  assert.equal(pickFocus(list, at(0, 64, 0), 'eve', 3).id, 2)
  assert.equal(pickFocus(list, at(0, 64, 0), 'Mallory', null), null)
})

test('a friend in the line of the swing blocks it, one beside the line does not', () => {
  const f = new Friends('Live_Fonam', ['Crew1', 'Crew2'])
  const eye = at(0, 65.62, 0)
  const enemy = player(9, 'Eve', at(0, 64, 4))
  const between = player(5, 'Crew2', at(0, 64, 2))
  const beside = player(5, 'Crew2', at(2, 64, 2))
  const behind = player(5, 'Crew2', at(0, 64, 6))
  assert.equal(friendInTheWay(eye, enemy, [between], f), between)
  assert.equal(friendInTheWay(eye, enemy, [beside], f), null)
  assert.equal(friendInTheWay(eye, enemy, [behind], f), null)
  // attacking a friend directly is always blocked
  assert.ok(friendInTheWay(eye, player(1, 'Live_Fonam', at(0, 64, 2)), [], f))
})

test('control passing between profiles tells the crew once per switch', () => {
  const log = []
  const switches = []
  const kill = new Fake('kill', log)
  kill.profile = 'fight'
  const mine = new Fake('mine', log)
  mine.profile = 'mine'
  const mine2 = new Fake('dig', log)
  mine2.profile = 'mine'
  const idle = new Fake('idle', log)
  idle.always = true
  const m = new ModeManager([kill, mine, mine2, idle], { profileChanged: (a, b) => switches.push(`${a}>${b}`) })
  m.setOn('mine', {})
  m.tick()
  m.setOn('kill', {})
  m.tick()
  kill.want = false
  m.tick()
  mine.want = false
  m.setOn('dig', {})
  m.tick()  // mine to dig stays in the mine profile, no switch
  m.stopNow()
  assert.deepEqual(switches, ['idle>mine', 'mine>fight', 'fight>mine', 'mine>idle'])
})

test('kill mode closes in to open a fight, then hands the range back to the network', () => {
  const { approach } = require('../skills/fight')
  // not fighting yet: a mob waiting 8 to 16 blocks off is walked to, the network gets it within 5
  assert.equal(approach(12, false, false), 'chase')
  assert.equal(approach(8, false, false), 'chase')
  assert.equal(approach(5.5, true, false), 'chase')
  assert.equal(approach(4.8, true, false), 'fight')
  assert.equal(approach(5.5, false, false), 'fight')  // no flapping at the edge
  // fighting: the old rule, chase only beyond 16 and stop at 10, so it can keep range
  assert.equal(approach(12, false, true), 'fight')
  assert.equal(approach(17, false, true), 'chase')
  assert.equal(approach(12, true, true), 'chase')
  assert.equal(approach(9, true, true), 'fight')
})
