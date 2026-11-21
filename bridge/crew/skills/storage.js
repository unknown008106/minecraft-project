// Chests: finding the ones near a spot, reading what they hold, putting a haul in and taking materials out.
// Mining, building and farming share these, so every job treats his chests the same way: it only ever takes the
// items a job needs and only ever puts in what the job collected.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')

const CONTAINERS = ['chest', 'trapped_chest', 'barrel']
const NEAR_HOME = 8

// Containers within radius of center, nearest first
function findContainers (bot, center, radius = 16, max = 8) {
  const ids = CONTAINERS.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  const point = center ? new Vec3(center.x, center.y, center.z) : bot.entity.position
  return bot.findBlocks({ point, matching: ids, maxDistance: radius, count: max })
}

// What the bot carries, name to count
function countItems (bot) {
  const out = new Map()
  for (const it of bot.inventory.items()) out.set(it.name, (out.get(it.name) || 0) + it.count)
  return out
}

async function walkToContainer (bot, pos, token) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 3.5) return
  await goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), token, 30000)
}

async function openAt (bot, pos, token) {
  await walkToContainer(bot, pos, token)
  if (token?.cancelled) return null
  const block = bot.blockAt(pos)
  if (!block || !CONTAINERS.includes(block.name)) throw new Error(`no chest at ${pos}`)
  return bot.openContainer(block)
}

function windowCounts (win) {
  const out = new Map()
  for (const it of win.containerItems()) out.set(it.name, (out.get(it.name) || 0) + it.count)
  return out
}

// Name to count of one container
async function contents (bot, pos, token) {
  const win = await openAt(bot, pos, token)
  if (!win) return new Map()
  try {
    return windowCounts(win)
  } finally {
    win.close()
  }
}

// Puts every carried item that filter(item) accepts into the container. Returns how many items went in
async function deposit (bot, pos, filter, token) {
  const win = await openAt(bot, pos, token)
  if (!win) return 0
  let n = 0
  try {
    for (const item of bot.inventory.items().filter(filter)) {
      if (token?.cancelled) break
      const count = item.count  // the item object can change once it is in the chest
      try {
        await win.deposit(item.type, null, count)
        n += count
      } catch (err) {
        break  // full
      }
    }
  } finally {
    win.close()
  }
  return n
}

// Takes up to wants (name to count) out of one container. Returns name to count taken
async function withdraw (bot, pos, wants, token) {
  const taken = new Map()
  const win = await openAt(bot, pos, token)
  if (!win) return taken
  try {
    const have = windowCounts(win)
    for (const [name, want] of wants) {
      if (token?.cancelled) break
      const n = Math.min(want, have.get(name) || 0)
      if (n <= 0) continue
      const id = bot.registry.itemsByName[name]?.id
      if (id === undefined) continue
      try {
        await win.withdraw(id, null, n)
        taken.set(name, n)
      } catch (err) {
        break  // its own bag is full
      }
    }
  } finally {
    win.close()
  }
  return taken
}

// Everything the containers near center hold, name to count, with where each lot is
async function survey (bot, center, token, radius = 16) {
  const total = new Map()
  const where = []
  for (const pos of findContainers(bot, center, radius)) {
    if (token?.cancelled) break
    try {
      const c = await contents(bot, pos, token)
      where.push({ pos, items: c })
      for (const [k, v] of c) total.set(k, (total.get(k) || 0) + v)
    } catch (err) {
      // a chest it cannot reach or open is skipped
    }
  }
  return { total, where }
}

// Takes what a job needs from the containers near center. wants: name to count. Returns name to count taken
async function fetchFrom (bot, center, wants, token, radius = 16) {
  const left = new Map(wants)
  const got = new Map()
  const { where } = await survey(bot, center, token, radius)
  for (const { pos, items } of where) {
    if (token?.cancelled) break
    const ask = new Map([...left].filter(([k, v]) => v > 0 && (items.get(k) || 0) > 0))
    if (!ask.size) continue
    const taken = await withdraw(bot, pos, ask, token)
    for (const [k, v] of taken) {
      got.set(k, (got.get(k) || 0) + v)
      left.set(k, left.get(k) - v)
    }
  }
  return got
}

// Puts the haul into a container within NEAR_HOME of home. Without one it places a chest it carries next to home.
// Returns { stored, pos } or { stored: 0, reason }
async function storeAtHome (bot, home, filter, token, { log = () => {} } = {}) {
  let chests = findContainers(bot, home, NEAR_HOME, 4)
  if (!chests.length) {
    const placed = await placeChestNear(bot, home, token)
    if (!placed) return { stored: 0, reason: 'no chest at home and none in my bag' }
    chests = [placed]
  }
  let stored = 0
  for (const pos of chests) {
    if (token?.cancelled) break
    try {
      stored += await deposit(bot, pos, filter, token)
    } catch (err) {
      log(`${bot.username} could not use the chest at ${pos}: ${err.message}`)
    }
    if (!bot.inventory.items().some(filter)) break
  }
  return { stored, pos: chests[0] }
}

// Places a chest from its bag on open ground beside home, never where avoid(pos) says (a build's footprint).
// Returns its position or null
async function placeChestNear (bot, home, token, { avoid = () => false } = {}) {
  const chest = bot.inventory.items().find(i => i.name === 'chest')
  if (!chest) return null
  const base = new Vec3(Math.floor(home.x), Math.floor(home.y), Math.floor(home.z))
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
    if (token?.cancelled) return null
    const spot = base.offset(dx, 0, dz)
    if (avoid(spot)) continue
    const here = bot.blockAt(spot)
    const above = bot.blockAt(spot.offset(0, 1, 0))
    const floor = bot.blockAt(spot.offset(0, -1, 0))
    if (!here || !above || !floor) continue
    if (here.boundingBox !== 'empty' || above.boundingBox !== 'empty' || floor.boundingBox !== 'block') continue
    const p = bot.entity.position
    if (Math.floor(p.x) === spot.x && Math.floor(p.z) === spot.z && Math.abs(Math.floor(p.y) - spot.y) <= 1) continue
    try {
      await goTo(bot, new goals.GoalNear(spot.x, spot.y, spot.z, 3), token, 20000)
      await bot.equip(chest, 'hand')
      await bot.placeBlock(floor, new Vec3(0, 1, 0))
      return spot
    } catch (err) {
      // try the next spot
    }
  }
  return null
}

module.exports = { CONTAINERS, findContainers, countItems, contents, deposit, withdraw, survey, fetchFrom, storeAtHome, placeChestNear }
