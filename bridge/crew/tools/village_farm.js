// Turns a vanilla plains village farm (a structure file from the 1.21.11 server jar) into a crew blueprint.
//
//   unzip -p server/cache/mojang_1.21.11.jar META-INF/versions/1.21.11/server-1.21.11.jar > /tmp/server.jar
//   unzip -o -j /tmp/server.jar 'data/minecraft/structure/village/plains/houses/plains_*_farm_1.nbt' -d /tmp/farms
//   node bridge/crew/tools/village_farm.js /tmp/farms/plains_small_farm_1.nbt wheat_farm
//   node bridge/crew/tools/village_farm.js /tmp/farms/plains_large_farm_1.nbt wheat_farm_large
//
// The village's jigsaw block (where the street joins the farm) becomes a border log, and the blueprint's origin is
// the cell just outside it, so he stands where the street would be and the farm opens toward him. Wheat is planted
// as seeds (age 0), farmland and the composter lose their moisture and fill levels.

const fs = require('fs')
const nbt = require('prismarine-nbt')
const { saveBlueprint, checkBlueprint } = require('../skills/blueprint')
const registry = require('prismarine-registry')('1.21.11')

const SYMBOL = { oak_log: 'L', dirt: 'D', grass_block: 'D', farmland: 'F', water: 'W', wheat: 'w', composter: 'C', air: '.' }
const FACING_OF = { west_up: 'west', east_up: 'east', north_up: 'north', south_up: 'south' }

async function convert (file, name) {
  const { parsed } = await nbt.parse(fs.readFileSync(file))
  const d = nbt.simplify(parsed)
  const [sx, , sz] = d.size
  const states = d.palette.map(p => ({ name: p.Name.replace(/^minecraft:/, ''), props: p.Properties || {} }))
  let jigsaw = null
  let top = 0
  const grid = new Map()
  for (const b of d.blocks) {
    const s = states[b.state]
    const [x, y, z] = b.pos
    if (s.name === 'jigsaw') {
      jigsaw = { x, y, z, facing: FACING_OF[s.props.orientation] || 'west' }
      grid.set(`${x},${y},${z}`, 'L')
    } else {
      const ch = SYMBOL[s.name]
      if (!ch) throw new Error(`no symbol for ${s.name}`)
      grid.set(`${x},${y},${z}`, ch)
    }
    if (s.name !== 'air') top = Math.max(top, y)
  }
  if (!jigsaw) throw new Error('no jigsaw block, cannot tell where the entrance is')
  const height = top + 1
  const layers = []
  for (let y = 0; y < height; y++) {
    const rows = []
    for (let z = 0; z < sz; z++) {
      let row = ''
      for (let x = 0; x < sx; x++) row += grid.get(`${x},${y},${z}`) || ' '
      rows.push(row.replace(/\s+$/, ''))
    }
    layers.push(rows)
  }
  const [dx, dz] = { west: [-1, 0], east: [1, 0], north: [0, -1], south: [0, 1] }[jigsaw.facing]
  const bp = {
    name,
    description: sx > 7
      ? 'The plains village large wheat farm: oak log border, two water channels, farmland rows beside them, wheat and 2 composters'
      : 'The plains village small wheat farm: oak log border, a water channel down the middle, farmland rows on each side, wheat and a composter',
    source: `vanilla 1.21.11 ${file.split(/[\\/]/).pop()}`,
    size: [sx, height, sz],
    origin: [jigsaw.x + dx, 0, jigsaw.z + dz],
    facing: jigsaw.facing,
    palette: {
      L: { name: 'oak_log', state: { axis: 'y' } },
      D: 'dirt',
      F: 'farmland',
      W: 'water',
      w: 'wheat',
      C: 'composter',
      '.': 'air'
    },
    expand: sx === 7 ? { axis: 'x', unit: [1, 6] } : { axis: 'x', unit: [7, 12] }
  }
  // the large farm's east border sits at the last column, its last unit is columns 7 to 12
  bp.layers = layers
  const check = checkBlueprint(bp, registry)
  if (!check.ok) throw new Error(`${name}: ${check.errors.join(', ')}`)
  console.log(`${name}: ${saveBlueprint(bp)}`)
}

if (require.main === module) {
  const [file, name] = process.argv.slice(2)
  if (!file || !name) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 9).join('\n'))
    process.exit(1)
  }
  convert(file, name).catch(err => { console.error(err.message); process.exit(1) })
}

module.exports = { convert }
