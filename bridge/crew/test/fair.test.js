// Fair health in the crew (DEC-082), no server needed:  node --test bridge/crew/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { fairKind, setupFairHealth } = require('../skills/fight')
const { ENEMY_KINDS } = require('../../fair_health')

function fake () {
  const calls = []
  return { calls, setFairHealth (on, kind, regen) { calls.push([on, kind, regen]) } }
}

test('a fair health version gets the estimate, with the kind of its target', () => {
  const f = fake()
  setupFairHealth(f, { fair: true }, { type: 'player', username: 'Steve' })
  setupFairHealth(f, { fair: true }, { type: 'mob', name: 'zombie', id: 3 })
  assert.deepEqual(f.calls, [[true, 'player', true], [true, 'basic', false]])
})

test('a version without it keeps the real health', () => {
  const f = fake()
  setupFairHealth(f, { name: 'L4-v0006', rate: 10 }, { type: 'player' })
  assert.deepEqual(f.calls[0].slice(0, 1), [false])
})

test('kinds match fair_health.js', () => {
  assert.equal(fairKind({ type: 'player' }), 'player')
  assert.equal(fairKind({ type: 'mob' }), 'basic')
  assert.equal(fairKind(null), 'player')
  assert.ok(ENEMY_KINDS.player && ENEMY_KINDS.basic)
})
