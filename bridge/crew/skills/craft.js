// Crafting the simple things a build or a farm needs: planks, sticks, slabs, doors, torches, chests, fences, a hoe,
// a composter, bread. planItems works out the crafts and the raw materials from minecraft-data's 1.21.11 recipes
// (pure, tested without a server), craftAll runs them with Mineflayer, placing its own crafting table when a recipe
// needs one and picking it back up after.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
// What the crew may craft on its own
const CRAFTABLE = new RegExp('^(' + [
  `(${WOODS.join('|')})_(planks|slab|door|fence|fence_gate|stairs)`,
  'stick', 'torch', 'chest', 'crafting_table', 'wooden_hoe', 'stone_hoe', 'wooden_pickaxe', 'stone_pickaxe', 'wooden_axe', 'stone_axe',
  'wooden_shovel', 'stone_shovel', 'composter', 'bread', 'ladder', 'cobblestone_(slab|wall|stairs)', 'barrel'
].join('|') + ')$')
// What gather.js can get by itself
const GATHERABLE = new RegExp('^(' + [
  `(${WOODS.join('|')})_log`, 'cobblestone', 'dirt', 'sand', 'coal', 'wheat_seeds', `(${WOODS.join('|')})_sapling`
].join('|') + ')$')

function itemName (registry, x) {
  const id = typeof x === 'object' && x !== null ? x.id : x
  return registry.items[id]?.name
}

// A recipe as { result, count, needs: Map name to count per craft, table }
function describeRecipe (registry, r) {
  const needs = new Map()
  const add = n => { if (n) needs.set(n, (needs.get(n) || 0) + 1) }
  if (r.inShape) for (const row of r.inShape) for (const x of row) add(x === null || x === undefined ? null : itemName(registry, x))
  if (r.ingredients) for (const x of r.ingredients) add(itemName(registry, x))
  const w = r.inShape ? Math.max(...r.inShape.map(row => row.length)) : 0
  const h = r.inShape ? r.inShape.length : 0
  const table = r.inShape ? (w > 2 || h > 2) : (r.ingredients?.length || 0) > 4
  return { result: itemName(registry, r.result), count: r.result.count, needs, table }
}

// The wood a recipe variant uses (oak for oak_planks), or null
function woodOf (name) {
  for (const w of WOODS.slice().sort((a, b) => b.length - a.length)) if (name.startsWith(`${w}_`)) return w
  return null
}

// Picks the recipe for an item: one whose ingredients it has, else one made of its preferred wood
function chooseRecipe (registry, name, have, prefer) {
  const item = registry.itemsByName[name]
  if (!item) return null
  const all = (registry.recipes[item.id] || []).map(r => describeRecipe(registry, r))
    .filter(r => [...r.needs.keys()].every(n => CRAFTABLE.test(n) || GATHERABLE.test(n) || /_wool$|^wheat$|^iron_ingot$|^string$|^cobbled_deepslate$|^blackstone$/.test(n)))
  if (!all.length) return null
  const score = r => {
    let s = 0
    for (const [n, c] of r.needs) {
      if ((have.get(n) || 0) >= c) s += 10
      const w = woodOf(n)
      if (w && w === prefer) s += 3
      if (w && (have.get(`${w}_log`) || 0) > 0) s += 2
    }
    return s
  }
  return all.sort((a, b) => score(b) - score(a))[0]
}

// Works out how to get wants (name to count) from what it has. Returns { crafts: [{ name, times, table }],
// gather: Map, missing: Map, table: whether any craft needs a crafting table }. have is not changed
function planItems (registry, wants, have, { prefer = 'oak', canGather = GATHERABLE, tableNear = false } = {}) {
  const first = planOnce(registry, wants, have, prefer, canGather)
  // a recipe needs a crafting table and none stands nearby or rides in the bag: make one first (it gets picked
  // back up after, so it costs 4 planks once)
  if (first.table && !tableNear && !(have.get('crafting_table') > 0) && !wants.has('crafting_table')) {
    return planOnce(registry, new Map([['crafting_table', 1], ...wants]), have, prefer, canGather)
  }
  return first
}

function planOnce (registry, wants, have, prefer, canGather) {
  const stock = new Map(have)
  const crafts = []
  const gather = new Map()
  const missing = new Map()
  const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n)
  const take = (name, count, depth) => {
    const avail = stock.get(name) || 0
    const use = Math.min(avail, count)
    stock.set(name, avail - use)
    let left = count - use
    if (left <= 0) return
    if (CRAFTABLE.test(name) && depth < 8) {
      const r = chooseRecipe(registry, name, stock, prefer)
      if (r) {
        const times = Math.ceil(left / r.count)
        for (const [n, c] of r.needs) take(n, c * times, depth + 1)
        crafts.push({ name, times, table: r.table })
        add(stock, name, times * r.count - left)
        return
      }
    }
    if (canGather.test(name)) { add(gather, name, left); return }
    add(missing, name, left)
  }
  for (const [name, n] of wants) if (n > 0) take(name, n, 0)
  // a crafting table it does not carry costs 4 planks, it picks the table back up after
  const table = crafts.some(c => c.table)
  return { crafts: merge(crafts), gather, missing, table }
}

// Joins repeated crafts of the same item, keeping the first position so ingredients still come first
function merge (crafts) {
  const out = []
  const at = new Map()
  for (const c of crafts) {
    if (at.has(c.name)) out[at.get(c.name)].times += c.times
    else { at.set(c.name, out.length); out.push({ ...c }) }
  }
  return out
}

const INTERACTIVE = /chest|barrel|crafting_table|furnace|smoker|_door$|_bed$|composter|_trapdoor$|_fence_gate$|lever|_button$|anvil|loom|lectern|bell|hopper|dispenser|dropper|shulker_box|enchanting|grindstone|stonecutter|cartography|smithing|brewing|beacon|note_block|jukebox|cake|respawn_anchor|decorated_pot|crafter|chiseled_bookshelf/

// A crafting table within 6 blocks it can see, or one it places on free ground nearby (avoid(pos) keeps it off the
// building site). Returns the table block, and job.table remembers a table it placed so it can pick it up
async function ensureTable (bot, job, token, { avoid = () => false, log = () => {} } = {}) {
  const id = bot.registry.blocksByName.crafting_table.id
  if (job.table) {
    const b = bot.blockAt(job.table)
    if (b && b.name === 'crafting_table') {
      await nearBlock(bot, b.position, token)
      return bot.blockAt(job.table)
    }
    job.table = null
  }
  for (const pos of bot.findBlocks({ matching: id, maxDistance: 6, count: 4 })) {
    const b = bot.blockAt(pos)
    if (b && (bot.canSeeBlock(b) || pos.distanceTo(bot.entity.position) < 3)) {
      await nearBlock(bot, pos, token)
      return bot.blockAt(pos)
    }
  }
  let item = bot.inventory.items().find(i => i.name === 'crafting_table')
  if (!item) {
    const r = bot.recipesFor(bot.registry.itemsByName.crafting_table.id, null, 1, null)[0]
    if (!r) throw new Error('I need 4 planks for a crafting table')
    await bot.craft(r, 1, null)
    item = bot.inventory.items().find(i => i.name === 'crafting_table')
  }
  const spot = freeSpot(bot, avoid)
  if (!spot) throw new Error('no free spot for a crafting table')
  await nearBlock(bot, spot, token)
  await bot.equip(item, 'hand')
  await bot.placeBlock(bot.blockAt(spot.offset(0, -1, 0)), new Vec3(0, 1, 0))
  job.table = spot
  job.tableOurs = true
  log(`${bot.username} placed a crafting table at ${spot}`)
  return bot.blockAt(spot)
}

// Open ground beside the bot: air with air above and a full block below, not where it stands, not on the site
function freeSpot (bot, avoid) {
  const feet = bot.entity.position.floored()
  for (let r = 1; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (const dy of [0, -1, 1]) {
          const p = feet.offset(dx, dy, dz)
          if (avoid(p)) continue
          const here = bot.blockAt(p)
          const up = bot.blockAt(p.offset(0, 1, 0))
          const below = bot.blockAt(p.offset(0, -1, 0))
          if (!here || !up || !below) continue
          if (here.name !== 'air' || up.boundingBox !== 'empty' || below.boundingBox !== 'block' || INTERACTIVE.test(below.name)) continue
          return p
        }
      }
    }
  }
  return null
}

async function nearBlock (bot, pos, token, range = 3) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 0.5) return
  await goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), token, 20000)
}

// Asks the server for the whole bag again (a full window refresh), at most 3 seconds
async function resync (bot) {
  if (typeof bot._syncWindow !== 'function') return
  await Promise.race([bot._syncWindow(bot.inventory).catch(() => {}), sleep(3000)])
}

// Runs the crafts in order. Returns how many items it made
async function craftAll (bot, crafts, job, token, { avoid, log = () => {} } = {}) {
  let made = 0
  for (const c of crafts) {
    if (token?.cancelled) return made
    const id = bot.registry.itemsByName[c.name].id
    let left = c.times
    let tries = 0
    while (left > 0 && !token?.cancelled && tries++ < 4) {
      const table = c.table ? await ensureTable(bot, job, token, { avoid, log }) : null
      if (token?.cancelled) return made
      const r = bot.recipesFor(id, null, 1, table)[0]
      if (!r) throw new Error(`I can't craft ${c.name}, an ingredient is missing`)
      // as many as this recipe allows with what it carries
      let n = left
      for (const d of r.delta) if (d.count < 0) n = Math.min(n, Math.floor(bot.inventory.count(d.id) / -d.count))
      if (n <= 0) throw new Error(`I can't craft ${c.name}, an ingredient is missing`)
      try {
        await bot.craft(r, n, table)
      } catch (err) {
        // BUG-119: the small hut stopped on mineflayer's "missing ingredient" 0.13 s into its first crafts, with 36
        // logs in the bag. The 2 by 2 grid gets no resync after its last click (mineflayer resyncs only a table's
        // window), so the bag model can drift from the server's. Resync, say what it holds, and retry
        if (!/missing ingredient/.test(err.message) || tries >= 4) throw err
        const needs = r.delta.filter(d => d.count < 0).map(d => `${bot.registry.items[d.id]?.name} ${bot.inventory.count(d.id)}`)
        log(`${bot.username} craft ${c.name} x${n}: ${err.message} (has ${needs.join(', ')}, cursor ${bot.inventory.selectedItem?.name || 'empty'}), resyncing`)
        await resync(bot)
        continue
      }
      made += n * r.result.count
      left -= n
      if (!table) await resync(bot)
      await sleep(100)
    }
    log(`${bot.username} crafted ${c.times} times ${c.name}`)
  }
  return made
}

// Digs the crafting table it placed and picks it up
async function pickUpTable (bot, job, token) {
  if (!job.table || !job.tableOurs) return false
  const b = bot.blockAt(job.table)
  if (!b || b.name !== 'crafting_table') { job.table = null; return false }
  await nearBlock(bot, b.position, token)
  const axe = bot.inventory.items().find(i => /_axe$/.test(i.name))
  if (axe) await bot.equip(axe, 'hand')
  await bot.dig(b, true)
  await sleep(300)
  const drop = Object.values(bot.entities || {}).find(e => e.name === 'item' && e.position.distanceTo(b.position) < 3)
  if (drop) {
    try { await goTo(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5), token, 5000) } catch {}
  }
  job.table = null
  job.tableOurs = false
  return true
}

module.exports = { WOODS, CRAFTABLE, GATHERABLE, INTERACTIVE, planItems, chooseRecipe, describeRecipe, craftAll, ensureTable, pickUpTable, freeSpot, woodOf, resync }
