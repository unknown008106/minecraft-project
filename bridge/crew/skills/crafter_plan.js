// The crafter's planner: what to craft and smelt, in order, to get one item from what the bot carries, and what is
// still missing. Pure (no Minecraft in here), so test/crafter.test.js runs it without a server.
//
// Recipes come from Mojang's own 1.21.11 data (recipes/all-recipes-1.21.11.json, taken from the server jar), with
// item tags expanded, so "#minecraft:planks" or "#minecraft:stone_tool_materials" mean what they mean in the game.
// One slot key uses one item (three oak planks for a pickaxe head, not oak, spruce, birch), like Mineflayer's crafting.
//
//   const plan = planCraft('stone_pickaxe', new Map([['oak_log', 1], ['cobblestone', 2]]), { tableNear: true })
//   plan.steps    [{ kind: 'craft', name: 'oak_planks', times: 1, table: false, count: 4 }, ...]
//   plan.missing  Map { 'cobblestone' => 1 }

const path = require('path')

const DATA = require(path.join(__dirname, '..', 'recipes', 'all-recipes-1.21.11.json'))

// What the crafter makes, and the words people use for them
const TARGETS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'furnace', 'crafting_table']
const ALIASES = {
  wooden_pickaxe: ['wooden pickaxe', 'wood pickaxe', 'wooden pick', 'wood pick', 'plank pickaxe', 'planks pickaxe'],
  stone_pickaxe: ['stone pickaxe', 'cobblestone pickaxe', 'cobble pickaxe', 'stone pick', 'cobblestone pick', 'cobble pick'],
  iron_pickaxe: ['iron pickaxe', 'iron pick'],
  diamond_pickaxe: ['diamond pickaxe', 'diamond pick'],
  furnace: ['furnace', 'oven'],
  crafting_table: ['crafting table', 'craft table', 'workbench', 'work bench', 'table']
}
const LABEL = Object.fromEntries(TARGETS.map(t => [t, t.replace(/_/g, ' ')]))

// Things it crafts on the way to a target. Anything else (logs, cobblestone, diamonds, raw iron, coal) is a raw
// material: crafted only when the bag already holds all it takes (a diamond from a diamond block), never asked for
// in crafted form
const INTERMEDIATE = /^(.*_planks|stick|crafting_table|furnace|iron_ingot|(wooden|stone|iron|diamond)_pickaxe)$/
// What a plan may ask the gatherer (or the player) for: things you get by breaking blocks. Never a crafted form
// (an iron block or 27 nuggets for an ingot, a diamond block for diamonds)
const BASE = /^(.*_log|cobblestone|cobbled_deepslate|blackstone|raw_iron|iron_ingot|diamond|coal|charcoal|bamboo)$/

// Smelting fuel: how many items one burns (the vanilla burn time over 200 ticks), best first
const FUEL = [['coal_block', 80], ['coal', 8], ['charcoal', 8], ['blaze_rod', 12]]
const WOOD_FUEL = 1.5  // a log or a plank
const STICK_FUEL = 0.5

const bare = id => String(id).replace(/^minecraft:/, '')

// A tag's items, nested tags expanded
const tagCache = new Map()
function tagItems (tag) {
  const t = bare(tag.replace(/^#/, ''))
  if (tagCache.has(t)) return tagCache.get(t)
  const out = []
  for (const e of DATA.item_tags[t] || []) {
    if (e.startsWith('#')) out.push(...tagItems(e))
    else out.push(bare(e))
  }
  tagCache.set(t, out)
  return out
}

// An ingredient (an item, a tag, or a list of them) to the items that can fill the slot
function options (ing) {
  if (Array.isArray(ing)) return [...new Set(ing.flatMap(options))]
  if (ing && typeof ing === 'object') return options(ing.item || ing.tag || ing.id)
  const s = String(ing)
  return s.startsWith('#') ? tagItems(s) : [bare(s)]
}

// Crafting recipes for an item, as { key: { slotKey: [items], ... }, uses: { slotKey: count }, count, table }
const recipeCache = new Map()
function craftingRecipes (name) {
  if (recipeCache.has(name)) return recipeCache.get(name)
  const out = []
  for (const r of Object.values(DATA.recipes)) {
    if (bare(r.result?.id || '') !== name) continue
    if (r.type === 'minecraft:crafting_shaped') {
      const uses = {}
      for (const row of r.pattern) for (const ch of row) if (ch !== ' ') uses[ch] = (uses[ch] || 0) + 1
      const key = Object.fromEntries(Object.keys(uses).map(k => [k, options(r.key[k])]))
      const w = Math.max(...r.pattern.map(row => row.length))
      out.push({ key, uses, count: r.result.count || 1, table: w > 2 || r.pattern.length > 2 })
    } else if (r.type === 'minecraft:crafting_shapeless') {
      const uses = {}
      const key = {}
      r.ingredients.forEach((ing, i) => {
        const opts = options(ing)
        // equal ingredients share one slot key
        const k = Object.keys(key).find(x => key[x].join() === opts.join()) || `i${i}`
        key[k] = opts
        uses[k] = (uses[k] || 0) + 1
      })
      out.push({ key, uses, count: r.result.count || 1, table: r.ingredients.length > 4 })
    }
  }
  recipeCache.set(name, out)
  return out
}

// What smelts into an item in a furnace (raw_iron for iron_ingot)
function smeltInputs (name) {
  const out = []
  for (const r of Object.values(DATA.recipes)) {
    if (r.type === 'minecraft:smelting' && bare(r.result?.id || '') === name) out.push(...options(r.ingredient))
  }
  return out
}

const sum = m => [...m.values()].reduce((a, b) => a + b, 0)
const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n)

// One planning pass over a copy of the stock. Recursion: take what the bag holds, craft or smelt the rest, call
// the remainder missing
function planPass (target, count, have, { tableNear, furnaceNear, extra = [] }) {
  const st = { stock: new Map(have), steps: [], missing: new Map(), smelts: [], table: false }
  for (const [name, n] of extra) need(st, name, n, 0, { furnaceNear })
  need(st, target, count, 0, { furnaceNear })
  planFuel(st)
  st.table = st.steps.some(s => s.kind === 'craft' && s.table)
  return st
}

function clone (st) {
  return { stock: new Map(st.stock), steps: st.steps.map(s => ({ ...s })), missing: new Map(st.missing), smelts: st.smelts.map(s => ({ ...s })), table: st.table }
}

// The fewest missing items, then the fewest steps (smelting raw iron beats crafting ingots back from nuggets)
const score = t => sum(t.missing) * 1000 + t.steps.length

function need (st, name, n, depth, opts, chain = []) {
  const avail = st.stock.get(name) || 0
  const use = Math.min(avail, n)
  st.stock.set(name, avail - use)
  const left = n - use
  if (left <= 0) return
  // never through itself (iron ingot from nuggets from iron ingot), never deeper than 8 crafts
  if (depth > 8 || chain.includes(name)) { add(st.missing, name, left); return }
  const next = [...chain, name]

  // every way to make it, each tried on a copy
  const tries = []
  for (const r of craftingRecipes(name)) tries.push(tryCraft(st, name, left, r, depth, opts, next))
  if (smeltInputs(name).length) {
    const s = trySmelt(st, name, left, depth, opts, next)
    if (s) tries.push(s)
  }
  const base = sum(st.missing)
  const complete = tries.filter(t => sum(t.missing) === base)
  // an incomplete way only when all it lacks can be gathered
  const askable = tries.filter(t => [...t.missing].every(([k, v]) => v <= (st.missing.get(k) || 0) || BASE.test(k)))
  let best = null
  // a way that needs nothing new, or (for the things it is meant to make) the way that misses the least
  if (complete.length) best = complete.sort((a, b) => score(a) - score(b))[0]
  else if (INTERMEDIATE.test(name) && askable.length) best = askable.sort((a, b) => score(a) - score(b))[0]
  if (best) { Object.assign(st, best); return }
  add(st.missing, name, left)
}

function tryCraft (st, name, left, r, depth, opts, chain) {
  const t = clone(st)
  const times = Math.ceil(left / r.count)
  // each slot key picks the item that leaves the fewest missing (oak planks when it carries oak logs)
  for (const [k, items] of Object.entries(r.key)) {
    const n = r.uses[k] * times
    let pick = null
    for (const item of items) {
      const c = clone(t)
      need(c, item, n, depth + 1, opts, chain)
      const miss = sum(c.missing)
      if (!pick || miss < pick.miss) pick = { c, miss }
      if (miss === sum(t.missing)) break
    }
    Object.assign(t, pick.c)
  }
  t.steps.push({ kind: 'craft', name, times, table: r.table, count: times * r.count })
  add(t.stock, name, times * r.count - left)
  return t
}

// Smelting in a furnace: the furnace itself (one in reach, one in the bag, or one to craft), then the inputs.
// Fuel is planned once at the end from what is left
function trySmelt (st, name, left, depth, opts, chain) {
  // raw_iron, not an ore block (it never carries one, ores drop raw iron)
  const inputs = smeltInputs(name).filter(i => !/_ore$/.test(i))
  if (!inputs.length) return null
  const t = clone(st)
  if (!opts.furnaceNear && !t.smelts.length) need(t, 'furnace', 1, depth + 1, opts, chain)
  // the input it carries the most of
  const input = inputs.slice().sort((a, b) => (t.stock.get(b) || 0) - (t.stock.get(a) || 0))[0]
  need(t, input, left, depth + 1, opts, chain)
  t.smelts.push({ input, output: name, count: left })
  t.steps.push({ kind: 'smelt', input, output: name, count: left, fuel: null, fuelCount: 0 })
  return t
}

// Fuel for every smelt from what is left after the crafts: coal first, then spare planks, logs and sticks.
// Without enough, coal is missing
function planFuel (st) {
  for (const step of st.steps.filter(s => s.kind === 'smelt')) {
    let burn = step.count
    const fuels = []
    const takeFuel = (item, per) => {
      const avail = st.stock.get(item) || 0
      if (!avail || burn <= 0) return
      const n = Math.min(avail, Math.ceil(burn / per))
      st.stock.set(item, avail - n)
      burn -= n * per
      fuels.push([item, n])
    }
    for (const [item, per] of FUEL) takeFuel(item, per)
    for (const [item] of [...st.stock].filter(([k, v]) => v > 0 && /_planks$/.test(k))) takeFuel(item, WOOD_FUEL)
    for (const [item] of [...st.stock].filter(([k, v]) => v > 0 && /_log$/.test(k) && !/crimson|warped/.test(k))) takeFuel(item, WOOD_FUEL)
    takeFuel('stick', STICK_FUEL)
    if (burn > 0) {
      add(st.missing, 'coal', Math.ceil(burn / 8))
      fuels.push(['coal', Math.ceil(burn / 8)])
    }
    step.fuel = fuels
    step.fuelCount = fuels.reduce((n, [, c]) => n + c, 0)
  }
}

// Joins repeated crafts of one item at its first place, so ingredients still come before what uses them
function merge (steps) {
  const out = []
  const at = new Map()
  for (const s of steps) {
    if (s.kind === 'craft' && at.has(s.name)) {
      const o = out[at.get(s.name)]
      o.times += s.times
      o.count += s.count
    } else {
      if (s.kind === 'craft') at.set(s.name, out.length)
      out.push({ ...s })
    }
  }
  return out
}

// The plan for count of target from have (a Map of item name to count, the bot's real bag).
//   tableNear    a crafting table stands within reach (else it makes one, 4 planks, and counts the wood for it)
//   furnaceNear  a furnace stands within reach (else it makes one from 8 cobblestone when it has to smelt)
// Returns { steps, missing: Map, table: whether a craft needs the 3 by 3 grid, placeTable, placeFurnace }
function planCraft (target, have, { count = 1, tableNear = false, furnaceNear = false } = {}) {
  const opts = { tableNear, furnaceNear }
  let st = planPass(target, count, have, opts)
  let placeTable = false
  // a 3 by 3 recipe and no table in reach or in the bag: plan one first, its planks counted with the rest
  if (st.table && !tableNear && target !== 'crafting_table') {
    placeTable = true
    if (!((have.get('crafting_table') || 0) > 0)) st = planPass(target, count, have, { ...opts, extra: [['crafting_table', 1]] })
  }
  const placeFurnace = st.steps.some(s => s.kind === 'smelt') && !furnaceNear
  return { target, count, steps: merge(st.steps), missing: st.missing, table: st.table, placeTable, placeFurnace }
}

// "craft me a stone pickaxe", "can you craft a furnace please", "craft wood pickaxe" to { item } or { error },
// null when the line is not a craft request
function parseCraftRequest (text) {
  const t = String(text || '').toLowerCase().replace(/[!?.,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const m = t.match(/^(?:hey |ok |okay )?(?:(?:can|could|would|will) you |please |pls )*(craft|make|build) (?:me |us )?(?:a |an |one |another |1 )?(.*?)(?: (?:for me|please|pls|thanks|thank you))*$/)
  if (!m) return null
  const item = resolveTarget(m[2])
  if (item) return { item }
  // "make a wheat farm" or "build a hut" are not for the crafter, they go on to the other commands
  if (m[1] !== 'craft') return null
  return { error: `I can craft ${TARGETS.map(x => LABEL[x]).join(', ')}, not "${m[2]}"` }
}

// A few words to one of the targets, or null
function resolveTarget (words) {
  const w = String(words || '').toLowerCase().replace(/^minecraft:/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/pickaxes$/, 'pickaxe').replace(/furnaces$/, 'furnace').replace(/tables$/, 'table')
  if (!w) return null
  if (TARGETS.includes(w.replace(/ /g, '_'))) return w.replace(/ /g, '_')
  for (const t of TARGETS) if (ALIASES[t].includes(w)) return t
  return null
}

// "a stone pickaxe", "an iron pickaxe"
const aOrAn = label => `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`

// "1 cobblestone and 3 oak logs" for chat
function describeMissing (missing) {
  const parts = [...missing].filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name.replace(/_/g, ' ')}${n > 1 && !/s$/.test(name) ? 's' : ''}`)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

module.exports = { TARGETS, ALIASES, LABEL, aOrAn, planCraft, parseCraftRequest, resolveTarget, describeMissing, craftingRecipes, smeltInputs, tagItems }
