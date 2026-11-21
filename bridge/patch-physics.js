// Small fix to Mineflayer's movement physics (prismarine-physics), applied before Mineflayer loads.
//
// Vanilla cuts movement input to 20% while you use an item (blocking with a shield, charging a
// crossbow). prismarine-physics only slows sneaking, so without this our bots strafe at full speed
// behind a shield, which a real player cannot do. Fighter sets bot.fighterUsingItem.
//
// The patch rewrites the installed file once and is safe to run again, so a fresh npm install on
// another computer gets it the first time the bridge starts.

const fs = require('fs')
const path = require('path')

const file = path.join(path.dirname(require.resolve('prismarine-physics/package.json')), 'index.js')
const MARK = '// axe-pvp-bot: item use slowdown'

let src = fs.readFileSync(file, 'utf8')
if (!src.includes(MARK)) {
  const sneak = `    if (entity.control.sneak) {
      strafe *= physics.sneakSpeed
      forward *= physics.sneakSpeed
    }
`
  const ctor = '    this.control = control\n'
  if (!src.includes(sneak) || !src.includes(ctor)) {
    console.error('[bridge] prismarine-physics changed, item use slowdown patch not applied')
  } else {
    src = src.replace(sneak, `${sneak}    ${MARK}
    if (entity.isUsingItem) {
      strafe *= 0.2
      forward *= 0.2
    }
`)
    src = src.replace(ctor, `${ctor}    this.isUsingItem = !!bot.fighterUsingItem ${MARK}\n`)
    fs.writeFileSync(file, src)
    console.error('[bridge] patched prismarine-physics with the item use slowdown')
  }
}
