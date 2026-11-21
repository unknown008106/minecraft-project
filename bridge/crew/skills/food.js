// Keeping a bot fed: picking the best food it carries, eating, and gathering raw food before a long job.
// Cooking (a furnace and fuel) comes in a later phase.

const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./human')

const HUNGRY = 14          // eat below this much food (of 20)
const LOW_HEALTH = 14      // also eat to heal below this health while not fighting
const ENOUGH_FOOD = 10     // food points to carry before a long job
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
const BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const GATHER_RADIUS = 24
const GATHER_ANIMALS = 3
const HIT_TICKS = 12

function foodInfo (bot, item) {
  const f = bot.registry.foodsByName?.[item.name]
  if (!f || BAD.has(item.name)) return null
  return f
}

// The food it carries, best first (most food plus saturation)
function foods (bot) {
  return bot.inventory.items()
    .map(item => ({ item, f: foodInfo(bot, item) }))
    .filter(x => x.f)
    .sort((a, b) => (b.f.foodPoints + b.f.saturation) - (a.f.foodPoints + a.f.saturation))
}

function foodPointsCarried (bot) {
  return foods(bot).reduce((n, x) => n + x.f.foodPoints * x.item.count, 0)
}

function needsFood (bot, fighting) {
  if (bot.food < HUNGRY) return true
  return !fighting && bot.health < LOW_HEALTH && bot.food < 20
}

// Eats until it is no longer hungry or has nothing left. Returns how many items it ate
async function eat (bot, token) {
  let ate = 0
  while (!token.cancelled && bot.food < 20 && (bot.food < HUNGRY || bot.health < LOW_HEALTH)) {
    const best = foods(bot)[0]
    if (!best) break
    await bot.equip(best.item, 'hand')
    try {
      await bot.consume()
      ate++
    } catch (err) {
      if (token.cancelled) break
      await sleep(300)
      if (ate === 0) throw err
      break
    }
  }
  return ate
}

// Food lying on the ground, then animals nearby. Returns the food points gained
async function gatherFood (bot, token, log = () => {}) {
  const before = foodPointsCarried(bot)
  const near = e => e.position.distanceTo(bot.entity.position) <= GATHER_RADIUS
  for (let n = 0; n < GATHER_ANIMALS && !token.cancelled; n++) {
    const animal = Object.values(bot.entities)
      .filter(e => ANIMALS.has(e.name) && near(e) && e.isValid !== false)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!animal) {
      log(`${bot.username} sees no animals within ${GATHER_RADIUS}`)
      break
    }
    const r = await huntOne(bot, animal, token, log)
    log(`${bot.username} hunted a ${animal.name}: ${r}`)
  }
  return foodPointsCarried(bot) - before
}

// Walks up to one animal and hits it until it dies, then picks up the drops. A scripted gathering skill, separate
// from the fight profile (the trained network is for mobs and players that fight back)
async function huntOne (bot, animal, token, log) {
  const weapon = bot.inventory.items().find(i => /_sword$/.test(i.name)) || bot.inventory.items().find(i => /_axe$/.test(i.name))
  if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
  bot.pathfinder.setGoal(new goals.GoalFollow(animal, 1.5), true)
  const until = Date.now() + 20000
  let result = 'gave up after 20 s'
  try {
    while (!token.cancelled && Date.now() < until) {
      const e = bot.entities[animal.id]
      if (!e || e.isValid === false) { result = 'killed'; break }
      if (e.position.distanceTo(bot.entity.position) < 3) {
        await bot.lookAt(e.position.offset(0, e.height * 0.6, 0), true)
        bot.attack(e)
      }
      await bot.waitForTicks(HIT_TICKS)
    }
  } finally {
    bot.pathfinder.setGoal(null)
  }
  // the drops
  const spot = animal.position.clone()
  await sleep(400)
  for (let i = 0; i < 4 && !token.cancelled; i++) {
    const drop = Object.values(bot.entities).find(e => e.name === 'item' && e.position.distanceTo(spot) < 4)
    if (!drop) break
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.6)),
        sleep(5000).then(() => { throw new Error('too slow') })
      ])
    } catch {
      bot.pathfinder.setGoal(null)
      break
    }
  }
  return result
}

module.exports = { foods, foodPointsCarried, needsFood, eat, gatherFood, HUNGRY, LOW_HEALTH, ENOUGH_FOOD }
