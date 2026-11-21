// The crafter: one craft job ("craft me a stone pickaxe") from the bot's real bag to the item in the player's hands.
// Plans with crafter_plan.js, crafts with craft.js (the same crafting table handling as the builder), smelts raw iron
// in a furnace, and hands the item over by walking up and dropping it at the player's feet, all normal survival
// actions. CraftMode in behaviors.js runs it, so a fight can cut in at any await and the job picks up where it was.
//
// A job, kept across runs (the mode passes the same object every time):
//   { item, requester, phase, made, given, madeCount, furnace, table, tableOurs, missing, stats }
// Each run first takes back what an interrupted smelt left in the furnace, then plans again from the real bag, so
// a fight, a restart or materials handed over by the player all just mean "look again". The target itself is never
// crafted twice: job.made is set the moment the final craft lands, and from then on the run only delivers.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')
const { craftAll, ensureTable, pickUpTable, freeSpot, resync } = require('./craft')
const { planCraft, LABEL, describeMissing } = require('./crafter_plan')

const REACH = 6          // a crafting table or furnace this close counts as one to use
const GIVE_RANGE = 48    // the player this close (and loaded): walk over and hand it
const DROP_RANGE = 6     // items lying this close while it waits for materials get picked up
const SMELT_TICKS = 200  // one item in a furnace (10 s)

function bag (bot) {
  const m = new Map()
  for (const i of bot.inventory.items()) m.set(i.name, (m.get(i.name) || 0) + i.count)
  return m
}

function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// A crafting table or furnace within reach that it can see (or that touches it), or null
function stationNear (bot, name) {
  const def = bot.registry.blocksByName[name]
  if (!def) return null
  for (const pos of bot.findBlocks({ matching: def.id, maxDistance: REACH, count: 4 })) {
    const b = bot.blockAt(pos)
    if (b && (pos.distanceTo(bot.entity.position) < 3 || bot.canSeeBlock(b))) return b
  }
  return null
}

// The plan from the bag as it is now. The copies of the target it already carries are its own (a miner keeps its
// pickaxe), so they are left out and the plan makes a new one
function planNow (bot, job) {
  const have = bag(bot)
  have.delete(job.item)
  return planCraft(job.item, have, {
    tableNear: !!stationNear(bot, 'crafting_table') || !!(job.table && bot.blockAt(job.table)?.name === 'crafting_table'),
    furnaceNear: !!stationNear(bot, 'furnace') || !!(job.furnace && bot.blockAt(job.furnace)?.name === 'furnace')
  })
}

// Crafting materials lying close by, the ones a player threw over. Not an item lying at a player's feet (one it
// just handed over, or one they are about to pick up)
const MATERIAL = /(_log|_planks|^stick|^cobblestone|^cobbled_deepslate|^blackstone|^raw_iron|^iron_ingot|^iron_nugget|^diamond|^coal|^charcoal|^crafting_table|^furnace)$/
function dropsNear (bot, missing = null, range = DROP_RANGE) {
  const me = bot.entity.position
  const players = Object.values(bot.players || {}).map(p => p.entity).filter(e => e && e !== bot.entity)
  return Object.values(bot.entities || {})
    .filter(e => e.name === 'item' && e.position && e.position.distanceTo(me) <= range)
    .filter(e => {
      const item = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null
      return !item || missing?.has(item.name) || MATERIAL.test(item.name)
    })
    .filter(e => !players.some(p => p.position.distanceTo(e.position) < Math.min(1.5, e.position.distanceTo(me))))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

async function pickUpDrops (bot, missing, token) {
  let n = 0
  for (const e of dropsNear(bot, missing)) {
    if (token?.cancelled) return n
    if (!bot.entities[e.id]) continue
    try {
      await goTo(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.5), token, 5000)
      n++
    } catch {}
    await sleep(250)
  }
  return n
}

// A furnace to smelt in: the job's own, one within reach, or the one in the bag placed beside the bot
async function ensureFurnace (bot, job, token, log) {
  if (job.furnace) {
    const b = bot.blockAt(job.furnace)
    if (b?.name === 'furnace') { await near(bot, b.position, token); return bot.blockAt(job.furnace) }
    job.furnace = null
  }
  const b = stationNear(bot, 'furnace')
  if (b) { job.furnace = b.position; await near(bot, b.position, token); return bot.blockAt(b.position) }
  const item = bot.inventory.items().find(i => i.name === 'furnace')
  if (!item) throw new Error('I have no furnace to smelt in')
  const spot = freeSpot(bot, () => false)
  if (!spot) throw new Error('no free spot for a furnace')
  await near(bot, spot, token)
  await bot.equip(item, 'hand')
  await bot.placeBlock(bot.blockAt(spot.offset(0, -1, 0)), new Vec3(0, 1, 0))
  job.furnace = spot
  log(`${bot.username} placed a furnace at ${spot}`)
  return bot.blockAt(spot)
}

async function near (bot, pos, token, range = 3) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 0.5) return
  await goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), token, 20000)
}

// What a smelt interrupted by a fight left in the job's furnace: ingots, raw iron, fuel, all back in the bag
async function emptyFurnace (bot, job, token) {
  // only a furnace it filled itself and did not finish with (never someone's furnace it merely stands near)
  if (!job.furnace || !job.smelting) return
  const b = bot.blockAt(job.furnace)
  if (b?.name !== 'furnace') { job.furnace = null; job.smelting = false; return }
  await near(bot, b.position, token)
  if (token?.cancelled) return
  const f = await bot.openFurnace(b)
  try {
    if (f.outputItem()) await f.takeOutput()
    if (f.inputItem()) await f.takeInput()
    if (f.fuelItem()) await f.takeFuel()
    job.smelting = false
  } finally {
    f.close()
  }
}

// Smelts exactly step.count of step.input into step.output, then checks the bag holds them
async function smelt (bot, step, job, token, log) {
  const want = countOf(bot, step.output) + step.count
  const block = await ensureFurnace(bot, job, token, log)
  if (token?.cancelled) return false
  const reg = bot.registry.itemsByName
  await resync(bot)  // clicks from a stale copy of the bag put nothing in the furnace
  const f = await bot.openFurnace(block)
  try {
    const fuels = step.fuel.slice()
    const feed = async () => {
      // one kind of fuel fits the slot at a time: the next goes in once the slot is empty
      if (f.fuelItem() || !fuels.length) return
      const [name, n] = fuels.shift()
      const have = countOf(bot, name)
      if (have <= 0) throw new Error(`I ran out of ${name.replace(/_/g, ' ')} for the furnace`)
      await f.putFuel(reg[name].id, null, Math.min(n, have))
    }
    await feed()
    job.smelting = true
    await f.putInput(reg[step.input].id, null, step.count)
    // check the furnace really holds them (a refused click leaves it empty), else once more from a fresh copy
    const syncF = async () => { if (typeof bot._syncWindow === 'function') await Promise.race([bot._syncWindow(f).catch(() => {}), sleep(3000)]) }
    await syncF()
    // (fuel is no check: a burning furnace has already taken the coal out of its slot)
    const inside = (f.inputItem()?.count || 0) + (f.outputItem()?.count || 0)
    if (inside < step.count) {
      log(`${bot.username} the furnace holds ${inside} of ${step.count} ${step.input}, putting the rest in again`)
      await f.putInput(reg[step.input].id, null, step.count - inside)
    }
    const state = () => `input ${f.inputItem()?.count || 0}, fuel ${f.fuelItem()?.name || 'none'} ${f.fuelItem()?.count || 0}, burning ${f.fuel ?? '?'}, output ${f.outputItem()?.count || 0}`
    log(`${bot.username} smelting ${step.count} ${step.input} (${state()})`)
    let shown = Date.now()
    // while the furnace is open the bag lives in the furnace window (bot.inventory catches up when it closes)
    const outId = reg[step.output].id
    const held = () => typeof f.count === 'function' ? f.count(outId, null) : countOf(bot, step.output)
    const deadline = Date.now() + (step.count * SMELT_TICKS * 50) + 20000
    while (held() < want) {
      if (token?.cancelled) return false  // the rest stays in the furnace, emptyFurnace takes it on the next run
      if (f.outputItem()) await f.takeOutput()
      await feed()
      if (Date.now() - shown > 10000) { shown = Date.now(); log(`${bot.username} furnace: ${state()}, bag ${held()}/${want}`) }
      if (Date.now() > deadline) throw new Error(`the furnace stopped with ${held()} of ${want} ${step.output}`)
      await sleep(500)
    }
    if (f.fuelItem() && !f.inputItem()) await f.takeFuel()
    job.smelting = false
  } finally {
    f.close()
  }
  // the iron pickaxe is only crafted with the ingots really in the bag
  await resync(bot)
  if (countOf(bot, step.output) < want) throw new Error(`I have ${countOf(bot, step.output)} ${step.output}, I need ${want}`)
  job.stats.smelted += step.count
  return true
}

async function syncWin (bot, win) {
  if (typeof bot._syncWindow === 'function') await Promise.race([bot._syncWindow(win).catch(() => {}), sleep(3000)])
}

// One craft step by hand, the way a player does it: open the grid (the table, or the bag's own 2 by 2), wait for the
// server's copy of the window, put one ingredient per cell, shift click the result. Mineflayer's bot.craft fires all
// its clicks at once and takes the result from its own guess of the window; on the 1.21.11 server that crafted
// nothing about 1 time in 5 (it went 5 of 5 this way in the same test)
async function craftByHand (bot, step, job, token, log) {
  const reg = bot.registry
  const id = reg.itemsByName[step.name].id
  for (let i = 0; i < step.times; i++) {
    if (token?.cancelled) return
    const table = step.table ? await ensureTable(bot, job, token, { log }) : null
    if (token?.cancelled) return
    await resync(bot)
    const r = bot.recipesFor(id, null, 1, table)[0]
    if (!r) throw new Error(`I can't craft ${step.name.replace(/_/g, ' ')}, an ingredient is missing`)
    const w = table ? 3 : 2
    const cells = r.inShape
      ? r.inShape.flatMap((row, y) => row.map((ing, x) => ({ ing, slot: 1 + x + w * y })))
      : r.ingredients.map((ing, k) => ({ ing, slot: 1 + (k % w) + w * Math.floor(k / w) }))
    const win = table ? await bot.openBlock(table) : bot.inventory
    try {
      await syncWin(bot, win)
      const putBack = () => win.selectedItem ? bot.putSelectedItemRange(win.inventoryStart, win.inventoryEnd, win, null) : null
      for (const { ing, slot } of cells) {
        if (!ing || ing.id === -1) continue
        if (!win.selectedItem || win.selectedItem.type !== ing.id) {
          await putBack()
          const src = win.findInventoryItem(ing.id, null)
          if (!src) throw new Error(`I can't craft ${step.name.replace(/_/g, ' ')}, I have no ${reg.items[ing.id]?.name}`)
          await bot.clickWindow(src.slot, 0, 0)
        }
        await bot.clickWindow(slot, 1, 0)  // right click: one item into the cell
        await bot.waitForTicks(1)
      }
      await putBack()
      await bot.waitForTicks(2)
      await syncWin(bot, win)
      await bot.clickWindow(0, 0, 1)  // shift click the result into the bag
      await bot.waitForTicks(2)
    } finally {
      if (table) {
        try { bot.closeWindow(win) } catch {}
      } else {
        // the bag's grid keeps what a refused craft left in it: back to the bag
        for (let s = 1; s <= 4; s++) if (win.slots[s]) { try { await bot.clickWindow(s, 0, 1) } catch {} }
      }
    }
  }
  log(`${bot.username} crafted ${step.times} times ${step.name}`)
}

// craftByHand on a real server, craft.js's craftAll on the test bot (it has no windows)
async function craftStep (bot, step, job, token, log) {
  if (typeof bot.openBlock === 'function' && typeof bot.clickWindow === 'function' && bot.inventory?.slots) return craftByHand(bot, step, job, token, log)
  return craftAll(bot, [{ name: step.name, times: step.times, table: step.table }], job, token, { log })
}

// A few steps back after a drop, so after the 2 s pickup delay the player is the one standing on it, not the bot
async function stepBack (bot) {
  if (typeof bot.waitForTicks !== 'function') return
  bot.setControlState('back', true)
  await bot.waitForTicks(6)
  bot.setControlState('back', false)
}

// Resolves true when the server says this player picked an item up within ms (Mineflayer's playerCollect), else false
function pickedUpBy (bot, name, ms) {
  if (typeof bot.on !== 'function' || typeof bot.removeListener !== 'function') return Promise.resolve(false)
  return new Promise(resolve => {
    const on = (collector) => { if (collector?.username === name) done(true) }
    const timer = setTimeout(() => done(false), ms)
    function done (v) { clearTimeout(timer); bot.removeListener('playerCollect', on); resolve(v) }
    bot.on('playerCollect', on)
  })
}

// Walks to the player and drops the item at their feet. 'given', 'far' (keep it and say it is ready) or 'cancelled'
async function deliver (bot, job, token, hooks) {
  const player = bot.players[job.requester]?.entity
  if (!player || player.position.distanceTo(bot.entity.position) > GIVE_RANGE) return 'far'
  try {
    // a fixed goal by the player (pathfinder.goto never settles on a moving GoalFollow)
    await goTo(bot, new goals.GoalNear(player.position.x, player.position.y, player.position.z, 1), token, 30000)
  } catch {
    if (token?.cancelled) return 'cancelled'
    if (player.position.distanceTo(bot.entity.position) > 3.5) return 'far'
  }
  if (token?.cancelled) return 'cancelled'
  const p = bot.players[job.requester]?.entity
  if (!p || p.position.distanceTo(bot.entity.position) > 3.5) return 'far'
  // at their feet from a block away: a drop thrown level flies about 3 blocks, past them
  await bot.lookAt(p.position.offset(0, 0.2, 0), true)
  // the bag as the server sees it: after crafting at a table Mineflayer's copy can be off by a slot (BUG-119), and a
  // toss from the wrong slot does nothing on the server
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
  await resync(bot)
  const before = countOf(bot, job.item)
  if (before <= 0) return 'given'  // already in their hands (a toss that landed just before a fight cut in)
  const id = bot.registry.itemsByName[job.item].id
  // set first: if the toss lands while a fight cuts in, the next run must not toss a second one
  job.given = true
  let caught = false
  for (let tries = 0; tries < 3 && !caught; tries++) {
    if (countOf(bot, job.item) < before) break  // on the ground by them, not yet picked up
    const picked = pickedUpBy(bot, job.requester, 4000)
    hooks.onGiving?.(job)
    // the server throws along the facing it last heard, so let the turn reach it first
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(3)
    try { await bot.toss(id, null, 1) } catch (err) { hooks.log?.(`${bot.username} toss ${job.item}: ${err.message}`) }
    await stepBack(bot)
    caught = await picked
    await resync(bot)  // did the server really take it
    if (!caught) hooks.log?.(`${bot.username} toss ${tries + 1} of ${job.item}: ${job.requester} has not picked it up yet`)
  }
  if (!caught && countOf(bot, job.item) < before) {
    // it lies at their feet: step aside so they get it and the bot does not
    caught = await pickedUpBy(bot, job.requester, 4000)
    await resync(bot)
  }
  if (!caught && countOf(bot, job.item) >= before) {
    job.given = false
    throw new Error(`the server did not take my ${LABEL[job.item] || job.item} when I dropped it`)
  }
  hooks.log?.(`${bot.username} gave ${job.item} to ${job.requester}${caught ? ' (picked up)' : ' (dropped at their feet)'}`)
  hooks.onGiven?.(job)
  return 'given'
}

// One run of a craft job. Returns { result, ... }:
//   missing   { missing: Map }  the bag lacks these (the mode asks the gatherer or the player, then runs again)
//   given     the player has it
//   far       made, kept, the player is out of reach (the mode says it is ready and hands it over later)
//   cancelled a higher mode took control (the mode runs it again later)
async function runCraftJob (bot, job, token, hooks = {}) {
  const log = hooks.log || (() => {})
  job.stats = job.stats || { crafted: 0, smelted: 0, runs: 0 }
  job.stats.runs++

  // Each pass plans from the bag as the server has it and does what is left. A craft the server did not take (its
  // copy of the bag and Mineflayer's can drift apart, BUG-119) just shows up as still to do on the next pass
  for (let pass = 0; !job.made && pass < 3; pass++) {
    // materials the player threw over while it waited
    if (job.missing) await pickUpDrops(bot, job.missing, token)
    await emptyFurnace(bot, job, token)
    if (token?.cancelled) return { result: 'cancelled' }
    await resync(bot)
    const plan = planNow(bot, job)
    job.plan = plan
    if (plan.missing.size) {
      job.missing = plan.missing
      return { result: 'missing', missing: plan.missing }
    }
    job.missing = null
    log(`${bot.username} craft ${job.item}${pass ? ` (pass ${pass + 1})` : ''}: ${plan.steps.map(s => s.kind === 'craft' ? `${s.name} x${s.times}` : `smelt ${s.count} ${s.input}`).join(', ')}`)
    for (const step of plan.steps) {
      if (token?.cancelled) return { result: 'cancelled' }
      await resync(bot)
      if (step.kind === 'smelt') {
        if (!await smelt(bot, step, job, token, log)) return { result: 'cancelled' }
        continue
      }
      const final = step.name === job.item
      const before = countOf(bot, job.item)
      // uses a table within reach or places one (from the bag, or crafted from the planks the plan counted)
      await craftStep(bot, step, job, token, log)
      job.stats.crafted += step.times
      if (!final) continue
      // count it as the server has it
      await resync(bot)
      if (countOf(bot, job.item) > before) {
        // the one copy it was asked for: from here on a run only hands it over
        job.made = true
        job.madeCount = countOf(bot, job.item)
      } else {
        log(`${bot.username} craft ${job.item}: the server shows none after the craft, planning again from the bag`)
      }
      break
    }
    if (token?.cancelled && !job.made) return { result: 'cancelled' }
  }
  if (!job.made) throw new Error(`the crafts ran but I have no ${LABEL[job.item] || job.item}`)
  if (!job.madeLogged) { job.madeLogged = true; hooks.onMade?.(job) }
  // a crafting table it placed itself goes back in the bag (4 planks it may need next time)
  if (job.item !== 'crafting_table' && job.tableOurs) { try { await pickUpTable(bot, job, token) } catch (err) { log(`${bot.username} table pickup: ${err.message}`) } }

  if (job.given) return { result: 'given' }
  if (token?.cancelled) return { result: 'cancelled' }
  const r = await deliver(bot, job, token, hooks)
  return { result: r }
}

module.exports = { runCraftJob, planNow, stationNear, dropsNear, countOf, bag, deliver, smelt, emptyFurnace, describeMissing, GIVE_RANGE }
