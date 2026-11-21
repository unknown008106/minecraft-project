// The crew's chat commands: reading a chat line, telling commands from plain words, and checking each command.
// Pure functions with no Minecraft in them, so test/commands.test.js runs without a server.

const PREFIX = '!'
const DEFAULT_KILL_RADIUS = 50
const DEFAULT_GUARD_RADIUS = 16
const DEFAULT_MINE_COUNT = 5
const MAX_RADIUS = 128
const MAX_MINE_COUNT = 576  // 9 stacks
const HUMAN_LEVELS = ['off', 'light', 'full']

// Every command a bot understands, with its arguments, also listed for the translator's system prompt
const COMMANDS = {
  kill: '!kill [radius] [player]  attack every non-friend within the radius (default 50), all on one shared target',
  guard: '!guard [radius]  keep attacking hostile mobs and non-friend players that come within the radius (default 16)',
  stop: '!stop  drop everything at once',
  come: '!come  walk to the owner once',
  follow: '!follow  keep following the owner',
  stay: '!stay  stop following or mining and stand still',
  mine: '!mine <block> [count]  mine a resource, for example !mine diamond 5',
  status: '!status  say what it is doing',
  give: '!give  walk to the owner and drop what it collected',
  human: '!human off|light|full  how human its mining looks',
  quiet: '!quiet  only the important news in chat (again for normal)',
  verbose: '!verbose  every bit of news in chat (again for normal)',
  build: '!build <blueprint> [here | x y z] [north|east|south|west]  build a blueprint where the owner stands or at x y z, for example !build small_hut here',
  farm: '!farm [wheat|carrot|potato] [here]  build a village wheat farm where the owner stands (here) or tend the nearest farm: harvest, replant, store',
  expand: '!expand <build>  add one module to a farm or a wall the crew built, for example !expand wheat_farm',
  explore: '!explore [radius]  scout around (default 64), report villages, caves, ores, lava, water and animals with coordinates, then come back',
  design: '!design <name> <description>  have Claude Sonnet draw a new blueprint from words, only for something the library does not have',
  blueprints: '!blueprints  list the blueprints the crew can build'
}
// Jobs one bot takes when the owner asks the whole crew (two bots on one site would get in each other's way)
const SOLO = new Set(['build', 'farm', 'expand', 'explore', 'design'])
const DEFAULT_EXPLORE_RADIUS = 64
const FACINGS = ['north', 'east', 'south', 'west']
const CROPS = { wheat: 'wheat', wheats: 'wheat', carrot: 'carrot', carrots: 'carrot', potato: 'potato', potatoes: 'potato' }

// Short names for ores and logs. Anything else is taken as a block name and checked against the game's block list
// when the bot runs it
const ORES = ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond', 'emerald']
const LOGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const ALIASES = {
  quartz: ['nether_quartz_ore'],
  nether_quartz: ['nether_quartz_ore'],
  nether_gold: ['nether_gold_ore'],
  debris: ['ancient_debris'],
  ancient_debris: ['ancient_debris'],
  netherite: ['ancient_debris'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  wood: LOGS.map(l => `${l}_log`),
  log: LOGS.map(l => `${l}_log`)
}
for (const ore of ORES) ALIASES[ore] = [`${ore}_ore`, `deepslate_${ore}_ore`]
for (const ore of ORES) ALIASES[`${ore}_ore`] = ALIASES[ore]

// "diamonds", "Iron Ore", "raw iron" all become a list of block names
function resolveBlocks (word) {
  let w = String(word || '').toLowerCase().trim().replace(/[\s-]+/g, '_').replace(/^minecraft:/, '').replace(/^raw_/, '')
  if (!w) return null
  if (ALIASES[w]) return { label: w.replace(/_ore$/, ''), blocks: ALIASES[w] }
  for (const cut of [/s$/, /es$/]) {
    const single = w.replace(cut, '')
    if (ALIASES[single]) return { label: single.replace(/_ore$/, ''), blocks: ALIASES[single] }
  }
  if (!/^[a-z_]+$/.test(w)) return null
  if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  return { label: w, blocks: [w] }
}

// A chat line as the bots see it ("<name> text", maybe after a [Not Secure] tag, see bridge.js onPlayerChat)
function parseChatLine (text) {
  const m = String(text).match(/^(?:\[[^\]]*\] )*<([^>]+)> (.*)$/)
  return m ? { sender: m[1], message: m[2].trim() } : null
}

const intIn = (s, lo, hi) => {
  if (!/^\d+$/.test(s)) return null
  return Math.min(hi, Math.max(lo, parseInt(s, 10)))
}

// One command from its words (without the "!" and the bot name). Returns { name, args } or { error }
function parseCommand (words) {
  const [head, ...rest] = words
  const name = String(head || '').toLowerCase()
  switch (name) {
    case 'kill': {
      const args = { radius: DEFAULT_KILL_RADIUS, target: null }
      for (const w of rest) {
        const n = intIn(w, 1, MAX_RADIUS)
        if (n !== null) args.radius = n
        else if (/^\w{1,16}$/.test(w)) args.target = w
        else return { error: `"${w}" is neither a radius nor a player name` }
      }
      return { name, args }
    }
    case 'guard': {
      if (rest.length > 1) return { error: 'guard takes one radius' }
      const radius = rest.length ? intIn(rest[0], 1, MAX_RADIUS) : DEFAULT_GUARD_RADIUS
      if (radius === null) return { error: `guard needs a number for the radius, got "${rest[0]}"` }
      return { name, args: { radius } }
    }
    case 'stop': case 'come': case 'follow': case 'stay': case 'status': case 'give': case 'quiet': case 'verbose': case 'blueprints':
      if (rest.length) return { error: `${name} takes nothing after it` }
      return { name, args: {} }
    case 'mine': {
      if (!rest.length) return { error: 'mine needs a block, for example !mine diamond 5' }
      let count = DEFAULT_MINE_COUNT
      let words = rest
      const last = rest[rest.length - 1]
      if (rest.length > 1 && /^\d+$/.test(last)) {
        count = intIn(last, 1, MAX_MINE_COUNT)
        words = rest.slice(0, -1)
      }
      const res = resolveBlocks(words.join('_'))
      if (!res) return { error: `I do not know the block "${words.join(' ')}"` }
      return { name, args: { block: res.label, blocks: res.blocks, count } }
    }
    case 'human': {
      const level = String(rest[0] || '').toLowerCase()
      if (rest.length !== 1 || !HUMAN_LEVELS.includes(level)) return { error: 'human takes off, light or full' }
      return { name, args: { level } }
    }
    case 'build': {
      if (!rest.length) return { error: 'build needs a blueprint, for example !build small_hut here' }
      const blueprint = rest[0].toLowerCase()
      if (!/^[a-z0-9_]{1,32}$/.test(blueprint)) return { error: `"${rest[0]}" is not a blueprint name` }
      let site = 'here'
      let i = 1
      if ((rest[1] || '').toLowerCase() === 'here') i = 2
      else if (rest.length >= 4 && rest.slice(1, 4).every(w => /^-?\d+$/.test(w))) {
        site = rest.slice(1, 4).map(Number)
        i = 4
      }
      let facing = null
      if (rest[i]) {
        facing = rest[i].toLowerCase()
        if (!FACINGS.includes(facing)) return { error: `"${rest[i]}" is not north, east, south or west` }
        i++
      }
      if (rest.length > i) return { error: 'build takes a blueprint, then here or x y z, then a facing' }
      return { name, args: { blueprint, site, facing } }
    }
    case 'farm': {
      const args = { crop: 'wheat', here: false }
      for (const w of rest.map(x => x.toLowerCase())) {
        if (w === 'here') args.here = true
        else if (CROPS[w]) args.crop = CROPS[w]
        else return { error: `I can farm wheat, carrot or potato, not "${w}"` }
      }
      return { name, args }
    }
    case 'expand': {
      if (rest.length !== 1 || !/^[a-z0-9_]{1,32}$/i.test(rest[0])) return { error: 'expand takes one build name, for example !expand wheat_farm' }
      return { name, args: { build: rest[0].toLowerCase() } }
    }
    case 'explore': {
      if (rest.length > 1) return { error: 'explore takes one radius' }
      const radius = rest.length ? intIn(rest[0], 8, 256) : DEFAULT_EXPLORE_RADIUS
      if (radius === null) return { error: `explore needs a number for the radius, got "${rest[0]}"` }
      return { name, args: { radius } }
    }
    case 'design': {
      if (rest.length < 2) return { error: 'design takes a new name and a description, for example !design watchtower a 5 by 5 stone tower 10 high' }
      const blueprint = rest[0].toLowerCase()
      if (!/^[a-z0-9_]{1,32}$/.test(blueprint)) return { error: `"${rest[0]}" is not a blueprint name (letters, digits and _)` }
      return { name, args: { blueprint, words: rest.slice(1).join(' ').slice(0, 1500) } }
    }
    default:
      return { error: `unknown command "${head || ''}", try !kill !guard !stop !come !follow !stay !mine !status !give !human !quiet !verbose !build !farm !expand !explore !design !blueprints` }
  }
}

// What a line from the owner asks for:
//   { type: 'command', targets, command }      "!kill 30", "!Crew1 mine iron 10", "!all stop"
//   { type: 'translate', targets, text }       "@crew go get me diamonds", "Crew2 come here please"
//   { type: 'error', targets, error }          a "!" line that is not a valid command
//   null                                        ordinary chat, ignored
// targets is 'all' or a list with one bot name (as the bot spells it)
function parseMessage (message, botNames) {
  const text = String(message || '').trim()
  const byLower = new Map(botNames.map(n => [n.toLowerCase(), n]))
  if (text.startsWith(PREFIX)) {
    const words = text.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean)
    let targets = 'all'
    const first = (words[0] || '').toLowerCase()
    if (byLower.has(first)) {
      targets = [byLower.get(first)]
      words.shift()
    } else if (first === 'all' || first === 'crew') {
      words.shift()
    }
    const command = parseCommand(words)
    if (command.error) return { type: 'error', targets, error: command.error }
    return { type: 'command', targets, command }
  }
  const crew = text.match(/^@crew\b[\s,:]*(.*)$/i)
  if (crew) return crew[1] ? { type: 'translate', targets: 'all', text: crew[1] } : null
  const named = text.match(/^@?(\w+)[\s,:]+(.+)$/)
  if (named && byLower.has(named[1].toLowerCase()) && !named[2].trim().startsWith(PREFIX)) {
    return { type: 'translate', targets: [byLower.get(named[1].toLowerCase())], text: named[2].trim() }
  }
  return null
}

// A command back to its "!" form, for chat replies and the translator's echo
function formatCommand (target, command) {
  const a = command.args || {}
  const parts = [command.name]
  if (command.name === 'kill') {
    if (a.radius !== DEFAULT_KILL_RADIUS) parts.push(a.radius)
    if (a.target) parts.push(a.target)
  } else if (command.name === 'guard' && a.radius !== DEFAULT_GUARD_RADIUS) {
    parts.push(a.radius)
  } else if (command.name === 'mine') {
    parts.push(a.block, a.count)
  } else if (command.name === 'human') {
    parts.push(a.level)
  } else if (command.name === 'build') {
    parts.push(a.blueprint, ...(Array.isArray(a.site) ? a.site : ['here']))
    if (a.facing) parts.push(a.facing)
  } else if (command.name === 'farm') {
    parts.push(a.crop)
    if (a.here) parts.push('here')
  } else if (command.name === 'expand') {
    parts.push(a.build)
  } else if (command.name === 'explore' && a.radius !== DEFAULT_EXPLORE_RADIUS) {
    parts.push(a.radius)
  } else if (command.name === 'design') {
    parts.push(a.blueprint, a.words)
  }
  return PREFIX + (target && target !== 'all' ? `${target} ` : '') + parts.join(' ')
}

module.exports = {
  COMMANDS,
  SOLO,
  FACINGS,
  DEFAULT_EXPLORE_RADIUS,
  DEFAULT_KILL_RADIUS,
  DEFAULT_GUARD_RADIUS,
  DEFAULT_MINE_COUNT,
  HUMAN_LEVELS,
  resolveBlocks,
  parseChatLine,
  parseCommand,
  parseMessage,
  formatCommand
}
