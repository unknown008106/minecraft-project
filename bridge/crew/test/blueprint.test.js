// Blueprint format, checker, rotation, expansion and crafting plans, no server needed:  node --test bridge/crew/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const bp = require('../skills/blueprint')
const { planItems } = require('../skills/craft')
const { Designer } = require('../designer')

test('every library blueprint passes the 1.21.11 checker', () => {
  const names = bp.listBlueprints()
  for (const n of ['small_hut', 'wheat_farm', 'wheat_farm_large', 'tree_farm', 'wall', 'storage_room']) assert.ok(names.includes(n), n)
  for (const n of names) {
    const b = bp.loadBlueprint(n)
    const c = bp.checkBlueprint(b, registry)
    assert.deepEqual(c.errors, [], n)
    // every block and state value is a real one
    for (const cell of bp.cellsOf(b)) {
      if (bp.AIRS.has(cell.name)) continue
      const def = registry.blocksByName[cell.name]
      assert.ok(def, `${n}: ${cell.name}`)
      const states = new Map((def.states || []).map(s => [s.name, s]))
      for (const [k, v] of Object.entries(cell.state)) {
        const s = states.get(k)
        assert.ok(s, `${n}: ${cell.name}.${k}`)
        if (s.values) assert.ok(s.values.includes(String(v)), `${n}: ${cell.name}.${k}=${v}`)
      }
    }
  }
})

test('the wheat farm is the plains village small farm', () => {
  const b = bp.loadBlueprint('wheat_farm')
  assert.deepEqual(b.size, [7, 2, 9])
  assert.match(b.source, /plains_small_farm_1\.nbt/)
  const cells = bp.cellsOf(b)
  const at = (x, y, z) => cells.find(c => c.x === x && c.y === y && c.z === z)?.name
  // oak log border all round, a water channel down the middle, farmland either side, wheat on it, a composter
  for (let x = 0; x < 7; x++) { assert.equal(at(x, 0, 0), 'oak_log'); assert.equal(at(x, 0, 8), 'oak_log') }
  for (let z = 0; z < 9; z++) { assert.equal(at(0, 0, z), 'oak_log'); assert.equal(at(6, 0, z), 'oak_log') }
  for (let z = 1; z <= 7; z++) assert.equal(at(3, 0, z), 'water')
  assert.equal(cells.filter(c => c.name === 'farmland').length, 27)
  assert.equal(cells.filter(c => c.name === 'wheat').length, 27)
  assert.equal(at(5, 1, 7), 'composter')
  assert.equal(at(5, 0, 7), 'dirt')
  const m = bp.checkBlueprint(b, registry)
  assert.equal(m.materials.get('oak_log'), 28)
  assert.equal(m.materials.get('wheat_seeds'), 27)
  assert.equal(m.materials.get('water_bucket'), 2)  // two buckets fill any channel
  assert.deepEqual(m.tools, ['hoe'])
})

test('the checker refuses bad blueprints with a reason', () => {
  const base = () => JSON.parse(JSON.stringify(bp.loadBlueprint('small_hut')))
  let b = base()
  b.palette.P = 'oak_plank'
  assert.ok(bp.checkBlueprint(b, registry).errors.some(e => /not a 1\.21\.11 block/.test(e)))
  b = base()
  b.palette.D.state.facing = 'up'
  assert.ok(bp.checkBlueprint(b, registry).errors.some(e => /facing cannot be up/.test(e)))
  b = base()
  b.size = [17, 5, 5]
  assert.ok(bp.checkBlueprint(b, registry).errors.some(e => /over the 16 by 12 by 16 limit/.test(e)))
  b = base()
  b.layers[0][0] = 'PPPPQ'
  assert.ok(bp.checkBlueprint(b, registry).errors.some(e => /"Q" is not in the palette/.test(e)))
  b = base()
  b.palette.X = 'oak_sign'
  b.layers[1][1] = 'PX..P'
  assert.ok(bp.checkBlueprint(b, registry).errors.some(e => /can't place oak_sign/.test(e)))
  b = base()
  b.layers[2][0] = 'LPPPL'  // a plank where the door's upper half goes
  assert.ok(bp.checkBlueprint(b, registry).errors.some(e => /door .* has oak_planks above it/.test(e)))
})

test('turning a blueprint moves its cells around the origin and turns facings and axes', () => {
  const b = bp.loadBlueprint('small_hut')
  const anchor = new Vec3(100, 63, 200)
  const north = bp.planCells(b, anchor, 'north', registry)
  const east = bp.planCells(b, anchor, 'east', registry)
  const doorN = north.find(c => c.name === 'oak_door' && c.props.half === 'lower')
  const doorE = east.find(c => c.name === 'oak_door' && c.props.half === 'lower')
  // the door is one block from the anchor, the hut behind it
  assert.deepEqual([doorN.pos.x, doorN.pos.y, doorN.pos.z], [100, 64, 201])
  assert.equal(doorN.props.facing, 'south')
  assert.deepEqual([doorE.pos.x, doorE.pos.y, doorE.pos.z], [99, 64, 200])
  assert.equal(doorE.props.facing, 'west')
  const box = bp.footprint(east)
  assert.ok(box.max.x < anchor.x, 'facing east, the hut stands west of the anchor')
  assert.deepEqual(bp.turnState({ axis: 'x', facing: 'north' }, 1), { axis: 'z', facing: 'east' })
  // his look: yaw 0 is north, so a build "here" faces south toward him
  assert.equal(bp.facingTowardOwner(0), 'south')
  assert.equal(bp.facingTowardOwner(Math.PI / 2), 'east')
})

test('expand adds one module of columns: the small farm grows into a two channel farm', () => {
  const b = bp.loadBlueprint('wheat_farm')
  const big = bp.expandBlueprint(b, 1)
  assert.deepEqual(big.size, [13, 2, 9])
  assert.equal(big.modules, 2)
  assert.equal(big.layers[0][3], 'LFFWFFLFFWFFL')
  assert.equal(big.layers[0][0], 'LLLLLLLLLLLLL')
  assert.ok(bp.checkBlueprint(big, registry).ok)
  const wall = bp.expandBlueprint(bp.loadBlueprint('wall'), 2)
  assert.deepEqual(wall.size, [25, 4, 1])
  assert.equal(wall.layers[1][0], 'LCCCCCCCLCCCCCCCLCCCCCCCL')
})

test('crafting plans: logs to planks, slabs, a door, sticks and torches, a bed is out of reach', () => {
  const have = new Map([['oak_log', 40]])
  const wants = bp.checkBlueprint(bp.loadBlueprint('small_hut'), registry).materials
  const p = planItems(registry, wants, have)
  assert.deepEqual([...p.missing], [['white_bed', 1]])
  assert.deepEqual([...p.gather], [['coal', 1]])
  const names = p.crafts.map(c => c.name)
  for (const n of ['oak_planks', 'oak_slab', 'oak_door', 'stick', 'torch']) assert.ok(names.includes(n), n)
  // ingredients come before what they make
  assert.ok(names.indexOf('oak_planks') < names.indexOf('oak_slab'))
  assert.ok(names.indexOf('stick') < names.indexOf('torch'))
  assert.ok(p.table, 'slabs and doors need a crafting table')
  // the composter of the village farm: 7 slabs on a crafting table it makes first, all from 3 logs
  const c = planItems(registry, new Map([['composter', 1]]), new Map([['oak_log', 3]]))
  assert.equal(c.missing.size, 0)
  assert.deepEqual(c.crafts.map(x => x.name), ['oak_planks', 'crafting_table', 'oak_slab', 'composter'])
  // with a table nearby it skips that
  const near = planItems(registry, new Map([['composter', 1]]), new Map([['oak_log', 3]]), { tableNear: true })
  assert.deepEqual(near.crafts.map(x => x.name), ['oak_planks', 'oak_slab', 'composter'])
  // nothing in the bag: logs get gathered
  const g = planItems(registry, new Map([['oak_planks', 8]]), new Map())
  assert.deepEqual([...g.gather], [['oak_log', 2]])
})

test('the designer keeps only blueprints the checker passes', () => {
  const d = new Designer({ credentials: null })
  assert.equal(d.enabled, false)
  const hut = bp.loadBlueprint('small_hut')
  const ok = d.check(`Here it is: ${JSON.stringify(hut)}`, 'my_hut')
  assert.equal(ok.blueprint.name, 'my_hut')
  assert.ok(ok.check.materials.get('oak_planks') > 0)
  const big = { ...hut, size: [20, 5, 5] }
  assert.ok(d.check(JSON.stringify(big), 'big').errors.length)
  assert.deepEqual(d.check('no json here', 'x').errors, ['the answer was not JSON'])
})
