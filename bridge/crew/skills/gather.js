// Getting the simple raw materials a build or a farm needs, the way a player would: logs from trees it can see,
// cobblestone from stone it can see or from a short staircase down, dirt, sand, coal from ore it can see (the miner
// otherwise), seeds from grass and saplings from leaves. Only blocks it can see from where it stands, the same rule
// as mining, and never a block of his: logs only from natural trees, leaves only natural ones, nothing inside a
// build the crew knows about.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')
const { pickTool } = require('./mine')
const { WOODS } = require('./craft')

const SEE = 24
const WANDERS = 6
const LOGS = WOODS.map(w => `${w}_log`)

// item to the blocks that give it
function sourcesFor (item) {
  if (LOGS.includes(item)) return { blocks: [item], cap: 64 }
  if (/_sapling$/.test(item)) return { blocks: [item.replace(/_sapling$/, '_leaves')], cap: 80, leaves: true }
  return {
    cobblestone: { blocks: ['stone'], pickaxe: true, cap: 96 },
    dirt: { blocks: ['dirt', 'grass_block', 'podzol'], cap: 96 },
    sand: { blocks: ['sand'], cap: 96 },
    coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], pickaxe: true, cap: 32 },
    wheat_seeds: { blocks: ['short_grass', 'tall_grass'], cap: 120 }
  }[item] || null
}

// A natural tree's log: going up the trunk it reaches leaves the game placed (persistent false)
function isNaturalLog (bot, pos) {
  let p = pos
  for (let i = 0; i < 32; i++) {
    const up = bot.blockAt(p.offset(0, 1, 0))
    if (!up || !/_log$/.test(up.name)) break
    p = p.offset(0, 1, 0)
  }
  let leaves = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(p.offset(dx, dy, dz))
        if (b && /_leaves$/.test(b.name) && b.getProperties().persistent === false) leaves++
      }
    }
  }
  return leaves >= 3
}

function isNaturalLeaves (block) {
  return !!block && /_leaves$/.test(block.name) && block.getProperties().persistent === false
}

// Blocks of these names it can see (or that touch it), nearest first, minus avoid(pos)
function visible (bot, names, avoid, { leaves = false, logs = false } = {}) {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  const found = bot.findBlocks({ matching: ids, maxDistance: SEE, count: 120 })
  const out = []
  let checks = 0
  for (const pos of found) {
    if (avoid(pos)) continue
    const b = bot.blockAt(pos)
    if (!b) continue
    if (leaves && !isNaturalLeaves(b)) continue
    if (logs && !isNaturalLog(bot, pos)) continue
    const near = pos.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= 4
    if (!near) {
      if (checks++ > 40) break
      if (!bot.canSeeBlock(b)) continue
    }
    out.push(pos)
    if (out.length >= 12) break
  }
  return out
}

async function collectDrops (bot, pos, token) {
  await sleep(300)
  for (let i = 0; i < 4 && !token?.cancelled; i++) {
    const drop = Object.values(bot.entities || {}).find(e => e.name === 'item' && e.position.distanceTo(pos) < 4)
    if (!drop) return
    try {
      await goTo(bot, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.6), token, 5000)
    } catch { return }
    await sleep(200)
  }
}

async function digOne (bot, pos, token) {
  const b = bot.blockAt(pos)
  if (!b || b.name === 'air') return false
  const reach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.4
  if (!reach()) await goTo(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), token, 20000)
  if (token?.cancelled) return false
  const again = bot.blockAt(pos)
  if (!again || again.name !== b.name) return false
  const pick = pickTool(bot, again)
  if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
  await bot.dig(again, true)
  await collectDrops(bot, pos.offset(0.5, 0.5, 0.5), token)
  return true
}

// A short staircase down from where it stands to reach stone (cobblestone on flat ground). Returns blocks dug
async function staircase (bot, item, want, token, log) {
  const start = bot.entity.position.floored()
  const yaw = bot.entity.yaw
  const [dx, dz] = [[0, -1], [-1, 0], [0, 1], [1, 0]][((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4]
  let feet = start
  let dug = 0
  for (let step = 0; step < 24 && !token?.cancelled && count(bot, item) < want; step++) {
    const next = feet.offset(dx, -1, dz)
    for (const p of [next.offset(0, 2, 0), next.offset(0, 1, 0), next]) {
      const b = bot.blockAt(p)
      if (!b) return dug
      if (['lava', 'water'].includes(b.name) || ['lava', 'water'].includes(bot.blockAt(p.offset(0, 1, 0))?.name)) return dug
      if (b.boundingBox === 'empty' && b.name !== 'short_grass') continue
      const pick = pickTool(bot, b)
      if (pick.error) return dug
      if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
      await bot.dig(b, true)
      dug++
    }
    const floor = bot.blockAt(next.offset(0, -1, 0))
    if (!floor || floor.boundingBox !== 'block') return dug
    try {
      await goTo(bot, new goals.GoalBlock(next.x, next.y, next.z), token, 8000)
    } catch (err) {
      log(`${bot.username} staircase: ${err.message}`)
      return dug
    }
    feet = next
  }
  // back up the stairs
  try { await goTo(bot, new goals.GoalBlock(start.x, start.y, start.z), token, 30000) } catch {}
  return dug
}

function count (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// Gets want more of item. Returns how many it got. avoid(pos) protects his builds and the site
async function gather (bot, item, want, token, { log = () => {}, say = () => {}, avoid = () => false, mine = null } = {}) {
  const src = sourcesFor(item)
  if (!src) return 0
  if (src.pickaxe && !bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) {
    say(`I need a pickaxe to get ${item}`)
    return 0
  }
  const startCount = count(bot, item)
  const target = startCount + want
  const home = bot.entity.position.clone()
  let broken = 0
  let wanders = 0
  const failed = new Set()
  const skip = p => avoid(p) || failed.has(p.toString())
  while (count(bot, item) < target && !token?.cancelled && broken < src.cap) {
    const spots = visible(bot, src.blocks, skip, { leaves: src.leaves, logs: LOGS.includes(item) })
    if (spots.length) {
      try {
        if (await digOne(bot, spots[0], token)) broken++
      } catch (err) {
        log(`${bot.username} gather ${item}: ${err.message}`)
        failed.add(spots[0].toString())
      }
      continue
    }
    if (item === 'cobblestone' && wanders >= 1) {
      broken += await staircase(bot, item, target, token, log)
      if (count(bot, item) < target && wanders >= WANDERS) break
    }
    if (item === 'coal' && mine && wanders >= 2) {
      await mine(['coal_ore', 'deepslate_coal_ore'], target - count(bot, item), token)
      break
    }
    if (wanders === 0) log(`${bot.username} sees no ${item} source it can reach within ${SEE} blocks, walking to look`)
    if (wanders++ >= WANDERS) break
    // walk a little way and look again, staying within 48 blocks of where it started
    const angle = Math.random() * Math.PI * 2
    const d = 12 + Math.random() * 10
    let x = bot.entity.position.x + Math.cos(angle) * d
    let z = bot.entity.position.z + Math.sin(angle) * d
    const off = Math.hypot(x - home.x, z - home.z)
    if (off > 48) { x = home.x + (x - home.x) * 48 / off; z = home.z + (z - home.z) * 48 / off }
    try {
      await goTo(bot, new goals.GoalNearXZ(x, z, 3), token, 20000)
    } catch (err) {
      log(`${bot.username} gather walk: ${err.message}`)
    }
  }
  const got = count(bot, item) - startCount
  log(`${bot.username} gathered ${got} ${item} (${broken} blocks broken, ${wanders} walks)`)
  return got
}

// Fills empty buckets from water it can see within 32 blocks. Returns how many it filled
async function fillBuckets (bot, want, token, { avoid = () => false } = {}) {
  let filled = 0
  for (let i = 0; i < want && !token?.cancelled; i++) {
    const bucket = bot.inventory.items().find(it => it.name === 'bucket')
    if (!bucket) break
    const id = bot.registry.blocksByName.water.id
    const spots = bot.findBlocks({ matching: b => b.type === id && Number(b.getProperties().level) === 0, maxDistance: 32, count: 40 })
      .filter(p => !avoid(p) && bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty')
    const pos = spots.find(p => bot.canSeeBlock(bot.blockAt(p)))
    if (!pos) break
    await goTo(bot, new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2), token, 20000)
    const before = count(bot, 'water_bucket')
    await bot.equip(bucket, 'hand')
    await bot.lookAt(pos.offset(0.5, 0.9, 0.5), true)
    await bot.waitForTicks(2)
    bot.activateItem()
    await bot.waitForTicks(4)
    if (count(bot, 'water_bucket') > before) filled++
    else break
  }
  return filled
}

module.exports = { gather, sourcesFor, isNaturalLog, isNaturalLeaves, visible, collectDrops, fillBuckets, count, LOGS }
