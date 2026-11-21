// A small fake world and bot for the crew skill tests, no server needed. Blocks are real prismarine-block objects
// for 1.21.11, so names, states, hardness, harvest tools and dig times match the game. Walking is instant: a
// pathfinder goal with a standing spot inside a 7 block box around it is reached at once. Pressing forward moves
// the bot a fifth of a block per tick and gravity drops it onto the next floor, enough for the tunnel stepping.
//
//   const { makeBot } = require('./mockbot')
//   const { bot, world } = makeBot({ groundY: 63 })      flat world: stone, 3 dirt, grass at 63, air above
//   world.set(new Vec3(3, 63, 0), 'iron_ore')
//   bot.give('stone_pickaxe', 1)

const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)
const { Recipe } = require('prismarine-recipe')(registry)

const key = p => `${p.x},${p.y},${p.z}`
const FACE_NAMES = { '0,-1,0': 'down', '0,1,0': 'up', '0,0,-1': 'north', '0,0,1': 'south', '-1,0,0': 'west', '1,0,0': 'east' }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const DIR = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }

// What a block drops when mined with the right tool (the parts the tests need)
const DROPS = {
  stone: 'cobblestone',
  grass_block: 'dirt',
  deepslate: 'cobbled_deepslate',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper',
  gold_ore: 'raw_gold',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  short_grass: null,
  tall_grass: null,
  oak_leaves: null,
  wheat: 'wheat',
  wall_torch: 'torch',
  farmland: 'dirt'
}

// The player's horizontal facing from a Mineflayer yaw (0 looks at -z)
function yawFacing (yaw) {
  const a = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4
  return ['north', 'west', 'south', 'east'][a]
}

class FakeWorld {
  constructor ({ groundY = 63, ground = 'grass_block', under = 'dirt', fill = 'stone', bottom = -64 } = {}) {
    this.groundY = groundY
    this.ground = ground
    this.under = under
    this.fill = fill
    this.bottom = bottom
    this.blocks = new Map()       // key to { name, props }
    this.containers = new Map()   // key to Item[]
    this.digs = 0
    this.placed = 0
  }

  natural (pos) {
    if (pos.y <= this.bottom) return 'bedrock'
    if (pos.y > this.groundY) return 'air'
    if (pos.y === this.groundY) return this.ground
    if (pos.y >= this.groundY - 3) return this.under
    return this.fill
  }

  get (pos) {
    const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    const s = this.blocks.get(key(p)) || { name: this.natural(p), props: null }
    const b = s.props ? Block.fromProperties(s.name, s.props, 0) : Block.fromStateId(registry.blocksByName[s.name].defaultState, 0)
    b.position = p
    b.skyLight = p.y > this.groundY ? 15 : 0
    b.light = 0
    return b
  }

  set (pos, name, props = null) {
    if (!registry.blocksByName[name]) throw new Error(`no block ${name}`)
    const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    this.blocks.set(key(p), { name, props })
    if ((name === 'chest' || name === 'barrel') && !this.containers.has(key(p))) this.containers.set(key(p), [])
  }

  fill3 (a, b, name, props = null) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
      for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
        for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) this.set(new Vec3(x, y, z), name, props)
      }
    }
  }

  name (pos) { return this.get(pos).name }
  props (pos) { return this.get(pos).getProperties() }
  solid (pos) { return this.get(pos).boundingBox === 'block' }
}

function makeBot ({ world = null, pos = null, username = 'Crew1', ...worldOpts } = {}) {
  world = world || new FakeWorld(worldOpts)
  const start = pos || new Vec3(0.5, world.groundY + 1, 0.5)
  const chats = []
  const controls = {}
  const items = []  // inventory slots 9 to 44 as Items (no slot numbers needed by the skills)

  const bot = {
    username,
    registry,
    world: { getBlock: p => world.get(p) },
    health: 20,
    food: 20,
    oxygenLevel: 20,
    chats,
    entities: {},
    players: {},
    game: { gameMode: 'survival' },
    entity: { position: start.clone(), yaw: 0, pitch: 0, onGround: true, isInWater: false, height: 1.8, eyeHeight: 1.62, effects: {}, velocity: new Vec3(0, 0, 0) },
    heldItem: null,
    trail: [],
    blockAt: p => world.get(p),
    chat: text => chats.push(String(text)),
    setControlState: (c, v) => { controls[c] = v },
    getControlState: c => !!controls[c],
    clearControlStates: () => { for (const k of Object.keys(controls)) controls[k] = false },
    stopDigging: () => {},
    swingArm: () => {},
    attack: () => {},
    deactivateItem: () => {},
    waitForChunksToLoad: async () => {},
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch },
    lookAt: async point => {
      const d = point.minus(bot.entity.position.offset(0, 1.62, 0))
      bot.entity.yaw = Math.atan2(-d.x, -d.z)
      bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    },
    on: () => {},
    once: () => {},
    removeListener: () => {}
  }

  // the inventory
  bot.inventory = {
    items: () => items.filter(i => i.count > 0),
    emptySlotCount: () => 36 - items.filter(i => i.count > 0).length,
    count: (id) => items.filter(i => i.type === id).reduce((n, i) => n + i.count, 0),
    slots: []
  }
  bot.give = (name, count = 1) => {
    const def = registry.itemsByName[name]
    if (!def) throw new Error(`no item ${name}`)
    let left = count
    for (const it of items) {
      if (left <= 0) break
      if (it.type === def.id && it.count < def.stackSize) {
        const n = Math.min(left, def.stackSize - it.count)
        it.count += n
        left -= n
      }
    }
    while (left > 0) {
      if (items.filter(i => i.count > 0).length >= 36) return count - left
      const n = Math.min(left, def.stackSize)
      items.push(new Item(def.id, n))
      left -= n
    }
    return count
  }
  bot.take = (name, count = 1) => {
    let left = count
    for (const it of items) {
      if (left <= 0) break
      if (it.name === name) {
        const n = Math.min(left, it.count)
        it.count -= n
        left -= n
      }
    }
    for (let i = items.length - 1; i >= 0; i--) if (items[i].count <= 0) items.splice(i, 1)
    if (bot.heldItem && bot.heldItem.count <= 0) bot.heldItem = null
    return count - left
  }
  bot.countOf = name => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  bot.equip = async (item, dest) => {
    if (!item || !items.includes(item)) {
      const found = items.find(i => i.type === (item?.type ?? item))
      if (!found) throw new Error('not in the inventory')
      item = found
    }
    if (dest === 'hand') bot.heldItem = item
  }
  bot.unequip = async () => { bot.heldItem = null }
  bot.tossStack = async item => { bot.take(item.name, item.count) }
  bot.toss = async (type, meta, count) => { bot.take(registry.items[type].name, count) }
  bot.consume = async () => {
    const f = registry.foodsByName[bot.heldItem?.name]
    if (!f) throw new Error('not food')
    bot.food = Math.min(20, bot.food + f.foodPoints)
    bot.take(bot.heldItem.name, 1)
  }

  // digging: the block becomes air and its drop goes straight into the bag
  bot.digged = []
  bot.dig = async (block) => {
    const b = world.get(block.position)
    if (b.name === 'air' || b.name === 'bedrock') throw new Error(`cannot dig ${b.name}`)
    world.digs++
    bot.digged.push(b.name)
    if (b.name === 'oak_door' || b.name.endsWith('_door')) {
      const other = b.getProperties().half === 'lower' ? 1 : -1
      world.set(b.position.offset(0, other, 0), 'air')
    }
    world.set(b.position, 'air')
    const tools = b.harvestTools ? Object.keys(b.harvestTools).map(Number) : null
    if (tools && !(bot.heldItem && tools.includes(bot.heldItem.type))) return
    let drop = b.name in DROPS ? DROPS[b.name] : b.name
    if (b.name === 'wheat') {
      if (Number(b.getProperties().age) === 7) { bot.give('wheat', 1); bot.give('wheat_seeds', 2) } else bot.give('wheat_seeds', 1)
      return
    }
    if (drop === 'wall_torch') drop = 'torch'
    if (drop && registry.itemsByName[drop]) bot.give(drop, 1)
  }

  // placing: the simple vanilla rules for the blocks the crew uses
  bot.placed = []
  function placeAt (ref, face, opts = {}) {
    const held = bot.heldItem
    if (!held || held.count <= 0) throw new Error('must be holding an item to place')
    const dest = ref.position.plus(face)
    const here = world.get(dest)
    if (here.boundingBox === 'block' && here.name !== 'water') throw new Error(`Server refused to place ${held.name} at ${dest}: the block is still ${here.name}`)
    const refBlock = world.get(ref.position)
    if (refBlock.boundingBox !== 'block' && !['farmland', 'water'].includes(refBlock.name)) throw new Error(`nothing to place against at ${ref.position}`)
    const faceName = FACE_NAMES[`${face.x},${face.y},${face.z}`]
    const look = yawFacing(bot.entity.yaw)
    const name = held.name
    let block = name
    let props = null
    let extra = null
    const cursorY = opts.delta ? opts.delta.y : (opts.half === 'top' ? 0.75 : opts.half === 'bottom' ? 0.25 : 0.5)
    if (name.endsWith('_door')) {
      props = { facing: look, half: 'lower', hinge: 'left', open: false, powered: false }
      extra = [dest.offset(0, 1, 0), name, { ...props, half: 'upper' }]
    } else if (name.endsWith('_bed')) {
      props = { facing: look, part: 'foot', occupied: false }
      const [dx, , dz] = DIR[look]
      extra = [dest.offset(dx, 0, dz), name, { ...props, part: 'head' }]
    } else if (name === 'chest' || name === 'furnace') {
      props = { facing: OPPOSITE[look], ...(name === 'chest' ? { type: 'single', waterlogged: false } : { lit: false }) }
    } else if (name === 'torch') {
      if (faceName === 'down') throw new Error('a torch cannot hang')
      if (faceName !== 'up') { block = 'wall_torch'; props = { facing: faceName } }
    } else if (name.endsWith('_slab')) {
      const top = faceName === 'down' || (faceName !== 'up' && cursorY > 0.5)
      props = { type: top ? 'top' : 'bottom', waterlogged: false }
    } else if (name.endsWith('_stairs')) {
      const top = faceName === 'down' || (faceName !== 'up' && cursorY > 0.5)
      props = { facing: look, half: top ? 'top' : 'bottom', shape: 'straight', waterlogged: false }
    } else if (name.endsWith('_log')) {
      props = { axis: face.x ? 'x' : face.z ? 'z' : 'y' }
    } else if (name.endsWith('_seeds') || name === 'carrot' || name === 'potato') {
      if (refBlock.name !== 'farmland' || faceName !== 'up') throw new Error('seeds need farmland')
      block = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes' }[name]
      props = { age: 0 }
    } else if (name.endsWith('_sapling')) {
      if (!['dirt', 'grass_block', 'podzol', 'coarse_dirt'].includes(refBlock.name)) throw new Error('saplings need dirt')
      props = { stage: 0 }
    } else if (!registry.blocksByName[name]) {
      throw new Error(`${name} is not a block`)
    }
    world.set(dest, block, props)
    if (extra) world.set(extra[0], extra[1], extra[2])
    world.placed++
    bot.placed.push({ pos: dest, name: block, props })
    bot.take(name, 1)
  }
  bot.placeBlock = async (ref, face) => {
    await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5))
    placeAt(ref, face)
  }
  bot._placeBlockWithOptions = async (ref, face, opts = {}) => {
    if (opts.forceLook !== 'ignore') await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5))
    placeAt(ref, face, opts)
  }

  // using an item on a block: a hoe tills, a bucket fills or empties
  bot.activateBlock = async (block, direction) => {
    const b = world.get(block.position)
    const held = bot.heldItem
    if (held && held.name.endsWith('_hoe') && ['dirt', 'grass_block'].includes(b.name) && world.get(b.position.offset(0, 1, 0)).name === 'air') {
      world.set(b.position, 'farmland', { moisture: 0 })
      return
    }
    if (held && held.name === 'water_bucket') {
      const d = direction || new Vec3(0, 1, 0)
      world.set(b.position.plus(d), 'water', { level: 0 })
      bot.take('water_bucket', 1)
      bot.give('bucket', 1)
      return
    }
    if (held && held.name === 'bucket' && b.name === 'water') {
      world.set(b.position, 'air')
      bot.take('bucket', 1)
      bot.give('water_bucket', 1)
    }
  }
  bot.activateItem = async () => {
    // a ray from the eye along the look, the first solid block or water source it meets
    const held = bot.heldItem
    if (!held) return
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
    let prev = eye.floored()
    for (let t = 0; t <= 5; t += 0.05) {
      const p = eye.plus(dir.scaled(t)).floored()
      if (p.equals(prev) && t > 0) continue
      const b = world.get(p)
      if (held.name === 'bucket' && b.name === 'water' && Number(b.getProperties().level) === 0) {
        world.set(p, 'air'); bot.take('bucket', 1); bot.give('water_bucket', 1); return
      }
      if (b.boundingBox === 'block' || b.name === 'farmland') {
        if (held.name === 'water_bucket') {
          world.set(prev, 'water', { level: 0 }); bot.take('water_bucket', 1); bot.give('bucket', 1)
        }
        return
      }
      prev = p
    }
  }

  // containers
  bot.openContainer = async (block) => {
    const k = key(block.position)
    if (!world.containers.has(k)) throw new Error('not a container')
    const inside = world.containers.get(k)
    return {
      containerItems: () => inside.filter(i => i.count > 0),
      deposit: async (type, meta, count) => {
        const name = registry.items[type].name
        if (inside.filter(i => i.count > 0).length >= 27 && !inside.some(i => i.type === type)) throw new Error('chest full')
        const n = bot.take(name, count)
        const it = inside.find(i => i.type === type)
        if (it) it.count += n
        else inside.push(new Item(type, n))
      },
      withdraw: async (type, meta, count) => {
        const it = inside.find(i => i.type === type)
        if (!it || it.count < count) throw new Error('not enough in the chest')
        it.count -= count
        bot.give(registry.items[type].name, count)
      },
      close: () => {}
    }
  }
  world.fillChest = (pos, list) => {
    world.set(pos, 'chest', { facing: 'north', type: 'single', waterlogged: false })
    const inside = world.containers.get(key(pos))
    for (const [name, count] of list) inside.push(new Item(registry.itemsByName[name].id, count))
  }

  // crafting with the real 1.21.11 recipes, same rules as Mineflayer's recipesFor
  bot.recipesFor = (itemType, meta, minResultCount, table) => {
    const n = minResultCount ?? 1
    return Recipe.find(itemType, meta).filter(r => {
      if (r.requiresTable && !table) return false
      const times = Math.ceil(n / r.result.count)
      return r.delta.every(d => bot.inventory.count(d.id) + d.count * times >= 0)
    })
  }
  bot.recipesAll = (itemType, meta, table) => Recipe.find(itemType, meta).filter(r => !r.requiresTable || table)
  bot.crafted = []
  bot.craft = async (recipe, count = 1, table) => {
    if (recipe.requiresTable && !table) throw new Error('recipe requires craftingTable')
    if (table && world.get(table.position).name !== 'crafting_table') throw new Error('no crafting table there')
    for (let i = 0; i < count; i++) {
      for (const d of recipe.delta) {
        const name = registry.items[d.id].name
        if (d.count < 0 && bot.inventory.count(d.id) < -d.count) throw new Error(`missing ${name}`)
      }
      for (const d of recipe.delta) {
        const name = registry.items[d.id].name
        if (d.count < 0) bot.take(name, -d.count)
        else bot.give(name, d.count)
      }
      bot.crafted.push(registry.items[recipe.result.id].name)
    }
  }

  // block search and sight
  bot.findBlocks = ({ matching, maxDistance = 16, count = 1, point = null }) => {
    const ids = typeof matching === 'function' ? null : new Set([].concat(matching))
    const test = b => ids ? ids.has(b.type) : matching(b)
    const c = (point || bot.entity.position).floored()
    const out = []
    const natural = ['air', 'stone', 'dirt', 'grass_block', 'bedrock', world.fill, world.under, world.ground]
      .map(n => registry.blocksByName[n]?.id)
    const scanAll = !ids || natural.some(id => ids.has(id))
    const r = Math.min(maxDistance, 24)
    if (scanAll) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            const p = c.offset(dx, dy, dz)
            if (p.distanceTo(c) > maxDistance) continue
            if (test(world.get(p))) out.push(p)
          }
        }
      }
    } else {
      for (const k of world.blocks.keys()) {
        const [x, y, z] = k.split(',').map(Number)
        const p = new Vec3(x, y, z)
        if (p.distanceTo(c) > maxDistance) continue
        if (test(world.get(p))) out.push(p)
      }
    }
    out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c))
    return out.slice(0, count)
  }
  bot.canSeeBlock = (block) => {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const target = block.position.offset(0.5, 0.5, 0.5)
    const d = target.minus(eye)
    const len = d.norm()
    for (let t = 0.2; t < len - 0.6; t += 0.2) {
      const p = eye.plus(d.scaled(t / len)).floored()
      if (p.equals(block.position)) break
      if (world.get(p).boundingBox === 'block') return false
    }
    return true
  }

  // standing spots and instant walking
  const passable = p => world.get(p).boundingBox === 'empty' && !['lava', 'water'].includes(world.name(p))
  const standable = p => passable(p) && passable(p.offset(0, 1, 0)) && world.get(p.offset(0, -1, 0)).boundingBox === 'block'
  bot.standable = standable
  bot.walks = 0
  bot.pathfinder = {
    goal: null,
    movements: null,
    setMovements: m => { bot.pathfinder.movements = m },
    setGoal: g => { bot.pathfinder.goal = g },
    stop: () => {},
    isMoving: () => false,
    goto: async (goal) => {
      const centre = goal.pos || (goal.x !== undefined ? new Vec3(goal.x, goal.y ?? bot.entity.position.y, goal.z) : bot.entity.position)
      const c = new Vec3(Math.floor(centre.x), Math.floor(centre.y), Math.floor(centre.z))
      let best = null
      for (let dx = -7; dx <= 7; dx++) {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dz = -7; dz <= 7; dz++) {
            const p = c.offset(dx, dy, dz)
            if (!standable(p)) continue
            if (!goal.isEnd(p)) continue
            const d = p.distanceTo(bot.entity.position)
            if (!best || d < best.d) best = { p, d }
          }
        }
      }
      if (!best) throw new Error('No path to the goal!')
      bot.entity.position = best.p.offset(0.5, 0, 0.5)
      bot.walks++
    }
  }

  // ticks: forward walks a fifth of a block along the yaw, gravity drops it to the next floor
  bot.ticks = 0
  bot.waitForTicks = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      bot.ticks++
      if (controls.forward) {
        const step = new Vec3(-Math.sin(bot.entity.yaw) * 0.2, 0, -Math.cos(bot.entity.yaw) * 0.2)
        const next = bot.entity.position.plus(step)
        if (passable(next.floored()) && passable(next.floored().offset(0, 1, 0))) bot.entity.position = next
      }
      let guard = 0
      while (passable(bot.entity.position.floored().offset(0, -1, 0)) && bot.entity.position.y > world.bottom + 1 && guard++ < 400) {
        bot.entity.position = bot.entity.position.offset(0, -1, 0)
      }
      bot.entity.position.y = Math.floor(bot.entity.position.y)
      bot.entity.onGround = true
      bot.entity.isInWater = world.name(bot.entity.position.floored()) === 'water'
    }
    await new Promise(resolve => setImmediate(resolve))
  }

  return { bot, world, registry, Vec3 }
}

module.exports = { makeBot, FakeWorld, yawFacing, registry }
