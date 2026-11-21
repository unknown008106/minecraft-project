// Blueprints: the JSON format, the checker, rotation, expansion, the cells to build and the materials they take.
// Pure functions over minecraft-data, so test/blueprint.test.js runs without a server.
//
// A blueprint (bridge/crew/blueprints/<name>.json):
//   name         small_hut (lower case letters, digits and _)
//   description  one line for chat and the translator
//   size         [x, y, z] in blocks: width (west to east), height, depth (north to south). At most 16 by 12 by 16
//   origin       [x, y, z], the cell that sits on the anchor. The anchor is the block under his feet for "here",
//                or the block under the feet position he types, so layer 0 is the ground layer
//   facing       the side its front (door, entrance) is on in its own coordinates: north, east, south or west.
//                !build turns it to the facing he asks for, by default toward him
//   palette      one character to a block: "P": "oak_planks", or "D": { "name": "oak_door", "state": { "facing": "south",
//                "half": "lower" } }. "." is air (cleared) and " " leaves whatever is there, unless the palette says otherwise
//   layers       bottom up. Each layer is a list of rows from z = 0 (the north row) to the south, each row a string from
//                x = 0 (west) to the east. Short rows and missing rows leave the rest as it is
//   expand       optional, for !expand: { "axis": "x", "unit": [from, to] }, columns from..to are one module and a new
//                copy goes in after column to (what follows moves along)
//   source       optional, where the layout comes from (a vanilla structure file, a guide, his words)

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const DIR = path.join(__dirname, '..', 'blueprints')
const MAX = { x: 16, y: 12, z: 16 }
const FACINGS = ['north', 'east', 'south', 'west']
const STEP = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const AIRS = new Set(['air', 'cave_air', 'void_air'])
const CROPS = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' }
// a cell asking for dirt is already right when it holds any of these
const DIRT_LIKE = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mycelium'])
// properties the builder cannot set or that the game sets by itself, never checked after placing
const FREE_PROPS = new Set(['waterlogged', 'powered', 'open', 'occupied', 'moisture', 'age', 'stage', 'level', 'snowy',
  'shape', 'type_chest', 'north', 'east', 'south', 'west', 'up', 'in_wall', 'distance', 'persistent', 'hinge'])

// How the builder places a block, or null when it cannot
function placementKind (name, registry) {
  if (AIRS.has(name)) return 'air'
  const b = registry.blocksByName[name]
  if (!b) return null
  const states = new Set((b.states || []).map(s => s.name))
  if (name === 'water') return 'water'
  if (name === 'farmland') return 'farmland'
  if (CROPS[name]) return 'crop'
  if (/_sapling$/.test(name)) return 'sapling'
  if (/_door$/.test(name) && name !== 'iron_door') return 'door'
  if (/_bed$/.test(name)) return 'bed'
  if (name === 'torch' || name === 'soul_torch') return 'torch'
  if (name === 'wall_torch' || name === 'soul_wall_torch') return 'wall_torch'
  if (/_slab$/.test(name)) return 'slab'
  if (/_stairs$/.test(name)) return 'stairs'
  if (name === 'ladder') return 'ladder'
  if (name === 'lantern' || name === 'soul_lantern') return 'lantern'
  if (/_carpet$/.test(name)) return 'carpet'
  if (['chest', 'trapped_chest', 'furnace', 'smoker', 'blast_furnace'].includes(name)) return 'facing_away'
  if (/_fence_gate$/.test(name)) return 'facing_look'
  if (/_fence$|_wall$|_pane$|^iron_bars$/.test(name)) return 'connect'
  if (states.has('axis')) return 'axis'
  if (states.has('facing') || states.has('rotation') || states.has('attachment') || states.has('face')) return null
  if (b.boundingBox !== 'block') return null
  return 'solid'
}

// The item a cell uses up, or null (air, the upper half of a door, the head of a bed, farmland made with a hoe)
function itemFor (name, props = {}) {
  if (AIRS.has(name) || name === 'farmland') return null
  if (/_door$/.test(name)) return props.half === 'upper' ? null : name
  if (/_bed$/.test(name)) return props.part === 'head' ? null : name
  if (name === 'wall_torch') return 'torch'
  if (name === 'soul_wall_torch') return 'soul_torch'
  if (CROPS[name]) return CROPS[name]
  if (name === 'water') return 'water_bucket'
  if (/_slab$/.test(name) && props.type === 'double') return name  // counted twice in materials
  return name
}

function paletteEntry (bp, ch) {
  const raw = bp.palette?.[ch]
  if (raw === undefined) {
    if (ch === '.') return { name: 'air', state: {} }
    if (ch === ' ') return null
    return undefined
  }
  if (raw === null) return null
  if (typeof raw === 'string') return { name: raw.replace(/^minecraft:/, ''), state: {} }
  return { name: String(raw.name || '').replace(/^minecraft:/, ''), state: { ...(raw.state || {}) } }
}

// Every cell of the blueprint in its own coordinates: { x, y, z, ch, name, state }, skipping " "
function cellsOf (bp) {
  const out = []
  ;(bp.layers || []).forEach((layer, y) => {
    ;(layer || []).forEach((row, z) => {
      for (let x = 0; x < String(row).length; x++) {
        const ch = row[x]
        const e = paletteEntry(bp, ch)
        if (!e) continue
        out.push({ x, y, z, ch, name: e.name, state: e.state })
      }
    })
  })
  return out
}

// Checks a blueprint against the 1.21.11 block list. Returns { ok, errors, warnings, materials, tools }
function checkBlueprint (bp, registry) {
  const errors = []
  const warnings = []
  if (!bp || typeof bp !== 'object') return { ok: false, errors: ['not a blueprint object'], warnings, materials: new Map(), tools: [] }
  if (!/^[a-z0-9_]{1,32}$/.test(bp.name || '')) errors.push('name must be lower case letters, digits and _')
  const size = bp.size
  if (!Array.isArray(size) || size.length !== 3 || size.some(n => !Number.isInteger(n) || n < 1)) {
    errors.push('size must be [x, y, z] whole numbers')
  } else {
    if (size[0] > MAX.x || size[2] > MAX.z || size[1] > MAX.y) errors.push(`size ${size.join(' by ')} is over the 16 by 12 by 16 limit`)
    if (!Array.isArray(bp.layers) || bp.layers.length !== size[1]) errors.push(`layers must hold ${size[1]} layers, it has ${bp.layers?.length ?? 0}`)
    ;(bp.layers || []).forEach((layer, y) => {
      if (!Array.isArray(layer)) { errors.push(`layer ${y} is not a list of rows`); return }
      if (layer.length > size[2]) errors.push(`layer ${y} has ${layer.length} rows, the depth is ${size[2]}`)
      layer.forEach((row, z) => {
        if (typeof row !== 'string') errors.push(`layer ${y} row ${z} is not a string`)
        else if (row.length > size[0]) errors.push(`layer ${y} row ${z} is ${row.length} long, the width is ${size[0]}`)
      })
    })
  }
  if (!FACINGS.includes(bp.facing)) errors.push('facing must be north, east, south or west')
  if (!Array.isArray(bp.origin) || bp.origin.length !== 3 || bp.origin.some(n => !Number.isInteger(n))) errors.push('origin must be [x, y, z] whole numbers')
  else if (Array.isArray(size) && (bp.origin[0] < -2 || bp.origin[2] < -2 || bp.origin[0] > size[0] + 1 || bp.origin[2] > size[2] + 1 || bp.origin[1] < 0 || bp.origin[1] >= size[1])) {
    errors.push('origin must be inside the size box or at most 2 blocks outside it on the ground layer')
  }
  if (bp.palette && typeof bp.palette !== 'object') errors.push('palette must map single characters to blocks')
  const used = new Set()
  for (const layer of bp.layers || []) for (const row of layer || []) for (const ch of String(row)) used.add(ch)
  for (const ch of used) {
    const e = paletteEntry(bp, ch)
    if (e === undefined) { errors.push(`"${ch}" is not in the palette`); continue }
    if (!e) continue
    const kind = placementKind(e.name, registry)
    const block = registry.blocksByName[e.name]
    if (!block && !AIRS.has(e.name)) { errors.push(`"${e.name}" is not a 1.21.11 block`); continue }
    if (!kind) { errors.push(`I can't place ${e.name} yet`); continue }
    const defs = new Map((block?.states || []).map(s => [s.name, s]))
    for (const [k, v] of Object.entries(e.state)) {
      const def = defs.get(k)
      if (!def) { errors.push(`${e.name} has no state "${k}"`); continue }
      const values = def.type === 'bool' ? ['true', 'false'] : def.type === 'int' ? Array.from({ length: def.num_values }, (_, i) => String(i)) : def.values
      if (values && !values.includes(String(v))) errors.push(`${e.name} ${k} cannot be ${v}`)
    }
    const item = itemFor(e.name, e.state)
    if (item && !registry.itemsByName[item]) errors.push(`no item for ${e.name}`)
  }
  for (const k of Object.keys(bp.palette || {})) if (k.length !== 1) errors.push(`palette key "${k}" must be one character`)
  if (bp.expand) {
    const u = bp.expand.unit
    if (bp.expand.axis !== 'x' || !Array.isArray(u) || u.length !== 2 || !(u[0] <= u[1]) || u[0] < 0 || (size && u[1] >= size[0])) {
      errors.push('expand must be { axis: "x", unit: [from, to] } inside the width')
    }
  }
  let materials = new Map()
  let tools = []
  if (!errors.length) {
    const cells = cellsOf(bp)
    // doors need their upper half free or listed, beds their head
    for (const c of cells) {
      if (c.state.half === 'lower' && /_door$/.test(c.name)) {
        const up = cells.find(d => d.x === c.x && d.y === c.y + 1 && d.z === c.z)
        if (up && !(up.name === c.name || AIRS.has(up.name))) errors.push(`the door at ${c.x} ${c.y} ${c.z} has ${up.name} above it`)
        if (c.y + 1 >= bp.size[1]) errors.push(`the door at ${c.x} ${c.y} ${c.z} has no room for its upper half`)
      }
    }
    const m = materialsFor(cells.map(c => ({ name: c.name, props: c.state })), () => false)
    materials = m.items
    tools = m.tools
    if (!cells.some(c => !AIRS.has(c.name))) errors.push('the blueprint places no blocks')
  }
  return { ok: errors.length === 0, errors, warnings, materials, tools }
}

// Items (name to count) and tools a list of cells takes. done(cell) says a cell needs nothing
function materialsFor (cells, done = () => false) {
  const items = new Map()
  const add = (k, n = 1) => items.set(k, (items.get(k) || 0) + n)
  let water = 0
  let farmland = 0
  for (const c of cells) {
    if (done(c)) continue
    const props = c.props || {}
    if (c.name === 'water') { water++; continue }
    if (c.name === 'farmland') { farmland++; if (c.needsDirt) add('dirt'); continue }
    const item = itemFor(c.name, props)
    if (!item) continue
    add(item, /_slab$/.test(c.name) && props.type === 'double' ? 2 : 1)
  }
  // two buckets of water make an endless source in a channel, so more never takes more than 2
  if (water) add('water_bucket', Math.min(water, 2))
  const tools = farmland ? ['hoe'] : []
  return { items, tools, water, farmland }
}

// Quarter turns clockwise (seen from above) from one facing to another
function turnsBetween (from, to) {
  return (FACINGS.indexOf(to) - FACINGS.indexOf(from) + 4) % 4
}

function turnFacing (f, k) {
  const i = FACINGS.indexOf(f)
  return i < 0 ? f : FACINGS[(i + k) % 4]
}

// (dx, dz) turned k quarter turns clockwise: north (0, -1) goes to east (1, 0)
function turnXZ (dx, dz, k) {
  for (let i = 0; i < k; i++) [dx, dz] = [-dz, dx]
  return [dx, dz]
}

function turnState (state, k) {
  const out = {}
  for (const [key, v] of Object.entries(state || {})) {
    if (key === 'facing' && FACINGS.includes(v)) out.facing = turnFacing(v, k)
    else if (key === 'axis' && (v === 'x' || v === 'z') && k % 2 === 1) out.axis = v === 'x' ? 'z' : 'x'
    else if (key === 'rotation') out.rotation = String((Number(v) + 4 * k) % 16)
    else if (FACINGS.includes(key)) out[turnFacing(key, k)] = v
    else out[key] = v
  }
  return out
}

// The facing a build gets when he does not name one: its front toward him, so it stands in front of him
function facingTowardOwner (yaw) {
  // Mineflayer yaw 0 looks at -z (north), pi/2 at -x (west)
  const a = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4
  const looking = ['north', 'west', 'south', 'east'][a]
  return turnFacing(looking, 2)
}

// The world cells of a blueprint placed with its origin on anchor (a Vec3, the ground block) and its front to facing.
// Each cell: { pos, bx, by, bz, name, props, kind, item }
function planCells (bp, anchor, facing, registry) {
  const k = turnsBetween(bp.facing, facing || bp.facing)
  const [ox, oy, oz] = bp.origin
  const out = []
  for (const c of cellsOf(bp)) {
    const [dx, dz] = turnXZ(c.x - ox, c.z - oz, k)
    const pos = new Vec3(anchor.x + dx, anchor.y + (c.y - oy), anchor.z + dz)
    const props = turnState(c.state, k)
    out.push({ pos, bx: c.x, by: c.y, bz: c.z, name: c.name, props, kind: placementKind(c.name, registry), item: itemFor(c.name, props) })
  }
  return out
}

// The footprint box of planned cells: { min, max } in world coordinates
function footprint (cells) {
  const min = new Vec3(Infinity, Infinity, Infinity)
  const max = new Vec3(-Infinity, -Infinity, -Infinity)
  for (const c of cells) {
    min.x = Math.min(min.x, c.pos.x); min.y = Math.min(min.y, c.pos.y); min.z = Math.min(min.z, c.pos.z)
    max.x = Math.max(max.x, c.pos.x); max.y = Math.max(max.y, c.pos.y); max.z = Math.max(max.z, c.pos.z)
  }
  return { min, max }
}

// A copy with times more modules along x (the unit columns repeated right after the unit)
function expandBlueprint (bp, times = 1) {
  if (!bp.expand) throw new Error(`${bp.name} has no module to add`)
  const [from, to] = bp.expand.unit
  const w = to - from + 1
  const grow = row => {
    const s = String(row).padEnd(bp.size[0], ' ')
    let unit = s.slice(from, to + 1)
    return s.slice(0, to + 1) + unit.repeat(times) + s.slice(to + 1)
  }
  const out = JSON.parse(JSON.stringify(bp))
  out.size = [bp.size[0] + w * times, bp.size[1], bp.size[2]]
  out.layers = bp.layers.map(layer => layer.map(grow))
  out.expand = { axis: 'x', unit: [from, to] }
  out.modules = (bp.modules || 1) + times
  return out
}

function listBlueprints (dir = DIR) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
  } catch {
    return []
  }
}

function loadBlueprint (name, dir = DIR) {
  const clean = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '')
  const file = path.join(dir, `${clean}.json`)
  if (!clean || !fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function saveBlueprint (bp, dir = DIR) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${bp.name}.json`)
  fs.writeFileSync(file, formatBlueprint(bp))
  return file
}

// JSON with each layer's rows on their own lines, so a blueprint reads like a picture
function formatBlueprint (bp) {
  const head = { ...bp }
  delete head.layers
  // short lists of numbers or words stay on one line
  const text = JSON.stringify(head, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (m, inner) => `[${inner.split(/,\s*/).join(', ')}]`)
  const lines = text.split('\n')
  lines.pop()
  lines[lines.length - 1] += ','
  lines.push('  "layers": [')
  bp.layers.forEach((layer, i) => {
    lines.push('    [')
    layer.forEach((row, j) => lines.push(`      ${JSON.stringify(row)}${j < layer.length - 1 ? ',' : ''}`))
    lines.push(`    ]${i < bp.layers.length - 1 ? ',' : ''}`)
  })
  lines.push('  ]', '}')
  return lines.join('\n') + '\n'
}

// A material list for chat: "26 oak_log, 27 wheat_seeds, 2 water_bucket"
function describeItems (items) {
  return [...items].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ')
}

module.exports = {
  MAX,
  FACINGS,
  STEP,
  AIRS,
  CROPS,
  DIRT_LIKE,
  FREE_PROPS,
  placementKind,
  itemFor,
  cellsOf,
  checkBlueprint,
  materialsFor,
  turnsBetween,
  turnFacing,
  turnXZ,
  turnState,
  facingTowardOwner,
  planCells,
  footprint,
  expandBlueprint,
  listBlueprints,
  loadBlueprint,
  saveBlueprint,
  formatBlueprint,
  describeItems,
  DIR
}
