// The crew's modes, highest priority first: kill, retreat, guard, eat, give, come, build, mine, explore, farm,
// follow, idle. Stop is not a mode, the manager checks it before any of these every tick (modes.js).
//
// Every mode belongs to one skill profile, and reaches the game only through that profile's skill:
//   fight    kill, guard                  the trained network behind fight(bot, target) (skills/fight.js)
//   survive  retreat, eat                 eating, gathering food and food from its farm (skills/food.js, farm.js)
//   mine     mine                         scripted mining (skills/mine.js)
//   build    build, farm                  blueprints, crafting and farming (skills/build.js, craft.js, farm.js)
//   move     give, come, explore, follow  pathfinder walks (explore: skills/explore.js)
// The manager switches profiles as control moves between modes, so any one skill can later be swapped for a
// learned policy without touching the others.

const { goals } = require('mineflayer-pathfinder')
const { Mode, ModeManager } = require('./modes')
const { enemiesNear, pickFocus } = require('./targets')
const { fight, stopFight } = require('./skills/fight')
const { mineJob, goTo } = require('./skills/mine')
const { foods, foodPointsCarried, needsFood, eat, gatherFood, ENOUGH_FOOD } = require('./skills/food')
const { buildJob } = require('./skills/build')
const { farmJob, foodFromFarm, nearestFarm } = require('./skills/farm')
const { exploreJob } = require('./skills/explore')

const KEEP = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots)$|^(shield|bow|crossbow|arrow|torch)$/
const VALUABLE = new Set(['diamond', 'emerald', 'debris', 'netherite', 'ancient_debris', 'gold'])
const RETREAT_HP = 6
const SAFE_HP = 10
const DANGER_RADIUS = 10
const SAFE_DISTANCE = 16

function ownerEntity (ctx) {
  return ctx.bot.players[ctx.crew.owner]?.entity || null
}

const nameOf = e => e.username || (e.name || 'something').replace(/_/g, ' ')

// Kill and guard share this: get the kit once, then fight whatever target() picks, switching when it changes
class FightMode extends Mode {
  constructor (name, ctx) {
    super(name)
    this.profile = 'fight'
    this.ctx = ctx
    this.focus = null
    this.kitReady = false
    this.kitAsked = false
    this.watched = null
  }

  onStart () {
    this.kitReady = false
    this.kitAsked = false
  }

  enter () {
    if (!this.kitAsked) {
      this.kitAsked = true
      this.ctx.crew.ensureKit(this.ctx.bot).finally(() => { this.kitReady = true })
    }
  }

  update () {
    if (!this.kitReady || !this.focus) return
    const done = fight(this.ctx.bot, this.focus)
    if (this.watched !== this.focus.id) {
      this.watched = this.focus.id
      const target = this.focus
      done.then(r => {
        if (r === 'dead') this.ctx.crew.event(this.ctx.bot, 'normal', `kill-${target.id}`, `Killed ${nameOf(target)}`)
        if (r === 'no-brain') this.ctx.crew.event(this.ctx.bot, 'key', 'no-brain', 'My fighting network is not running')
      })
    }
  }

  exit () {
    this.watched = null
    stopFight(this.ctx.bot)
  }
}

class KillMode extends FightMode {
  constructor (ctx) { super('kill', ctx) }

  onStart () {
    super.onStart()
    const bb = this.ctx.crew.blackboard
    bb.named = this.params.target || null
    bb.focusId = null
  }

  wants () {
    const { bot, crew } = this.ctx
    const owner = ownerEntity(this.ctx)
    const center = owner ? owner.position : bot.entity.position
    const list = enemiesNear(bot.entities, center, this.params.radius, crew.friends, bot.entity)
    const focus = pickFocus(list, center, crew.blackboard.named, crew.blackboard.focusId)
    if (!focus) {
      const named = crew.blackboard.named
      crew.announce(named ? `No ${named} within ${this.params.radius} blocks` : 'Area clear')
      this.focus = null
      this.finish('clear')
      return false
    }
    crew.blackboard.focusId = focus.id
    this.focus = focus
    return true
  }

  describe () {
    return `kill within ${this.params.radius}${this.focus ? ` on ${nameOf(this.focus)}` : ''}`
  }
}

class GuardMode extends FightMode {
  constructor (ctx) { super('guard', ctx) }

  wants () {
    const { bot, crew } = this.ctx
    const list = enemiesNear(bot.entities, bot.entity.position, this.params.radius, crew.friends, bot.entity)
    this.focus = list[0] || null
    return !!this.focus
  }

  describe () { return `guarding within ${this.params.radius}${this.focus ? `, fighting ${nameOf(this.focus)}` : ''}` }
}

// Low on health with an enemy close and no kill order: run, toward the owner when it can see him
class RetreatMode extends Mode {
  constructor (ctx) {
    super('retreat')
    this.profile = 'survive'
    this.ctx = ctx
    this.always = true
    this.threat = null
  }

  wants () {
    const { bot, crew, manager } = this.ctx
    if (manager.get('kill').on) return false
    const running = manager.active === this
    if (bot.health > (running ? SAFE_HP : RETREAT_HP)) return false
    const list = enemiesNear(bot.entities, bot.entity.position, running ? SAFE_DISTANCE : DANGER_RADIUS, crew.friends, bot.entity)
    this.threat = list[0] || null
    return !!this.threat
  }

  enter () {
    const { bot, crew } = this.ctx
    crew.event(bot, 'normal', 'retreat', 'Taking damage, retreating')
    stopFight(bot)
    bot.pathfinder.setMovements(crew.noDigMoves(bot))
    this.following = null
  }

  update () {
    if (!this.threat || this.following === this.threat) return
    this.following = this.threat
    this.ctx.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(this.threat, SAFE_DISTANCE)), true)
  }

  exit () {
    this.following = null
    this.ctx.bot.pathfinder.setGoal(null)
  }

  describe () { return 'retreating' }
}

// A mode that runs one async job and turns itself off when it ends. A higher mode taking over cancels the job,
// and the job starts again (keeping its progress) when the mode gets control back
class JobMode extends Mode {
  constructor (name, ctx, profile) {
    super(name)
    this.profile = profile
    this.ctx = ctx
    this.token = null
  }

  enter () {
    const token = { cancelled: false }
    this.token = token
    this.run(token).then(result => {
      if (!token.cancelled && (this.on || this.always)) {
        this.record(result || 'done')
        this.finish(result || 'done')
      }
      if (!token.cancelled) this.token = null
    }).catch(err => {
      this.ctx.crew.log(`${this.ctx.bot.username} ${this.name}: ${err.message}`)
      if (!token.cancelled) this.token = null
      if (!token.cancelled && (this.on || this.always)) {
        this.ctx.crew.event(this.ctx.bot, 'key', `${this.name}-failed`, `${this.name} failed: ${err.message}`.slice(0, 90))
        this.record('error', err.message)
        this.finish('error')
      }
    })
  }

  // A job cut short by !stop, !stay or another order is recorded too (the harness stops time capped runs)
  finish (result = 'done') {
    if (this.settle && (result === 'stopped' || result === 'off' || result === 'replaced') && this.job) this.record(result)
    super.finish(result)
  }

  // How the job ended, for the live test harness (crew.js --metrics). Modes keep their numbers in this.job.stats
  record (result, error = null) {
    const { bot, crew } = this.ctx
    const p = bot.entity?.position
    crew.metric?.({
      bot: bot.username,
      job: this.name,
      result,
      error,
      params: this.params,
      stats: this.job?.stats || null,
      pos: p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null
    })
  }

  exit () {
    if (this.token) this.token.cancelled = true
    this.token = null
    const bot = this.ctx.bot
    bot.pathfinder.setGoal(null)
    try { bot.stopDigging() } catch {}
  }

  async run () { return 'done' }
}

// Hungry (or hurt and not fighting) with food in the bag: eat. Out of food: say so now and then
class EatMode extends JobMode {
  constructor (ctx) {
    super('eat', ctx, 'survive')
    this.always = true
    this.retryAt = 0
    this.farmRetryAt = 0
  }

  wants () {
    if (this.token) return true  // finish the bite in progress
    const { bot, crew } = this.ctx
    if (Date.now() < this.retryAt || !needsFood(bot, false)) return false
    if (!foods(bot).length) {
      // a farm the crew built feeds it (B5): ripe crops, the farm chest, bread from wheat
      if (bot.food < 14 && Date.now() >= this.farmRetryAt && nearestFarm(crew.farms(), bot.entity.position, 96)) return true
      if (bot.food < 14) crew.event(bot, 'key', 'no-food', 'I am low on food and have none', 120000)
      this.retryAt = Date.now() + 10000
      return false
    }
    return true
  }

  async run (token) {
    const { bot, crew } = this.ctx
    if (!foods(bot).length) {
      crew.event(bot, 'normal', 'farm-food', 'Hungry, getting food from the farm', 60000)
      bot.pathfinder.setMovements(crew.buildMoves(bot))
      await foodFromFarm(bot, crew.farms(), token, { log: crew.log, foodPoints: () => foodPointsCarried(bot) })
      if (token.cancelled) return 'cancelled'
      if (!foods(bot).length) {
        this.farmRetryAt = Date.now() + 120000
        crew.event(bot, 'key', 'no-food', 'I am low on food and the farm has nothing ripe', 120000)
        return 'none'
      }
    }
    crew.event(bot, 'normal', 'eating', 'Low on food, eating', 60000)
    try {
      await eat(bot, token)
    } catch (err) {
      this.retryAt = Date.now() + 10000
      throw err
    }
    return 'done'
  }

  describe () { return 'eating' }
}

async function walkToOwner (ctx, token, range) {
  const owner = ownerEntity(ctx)
  if (!owner) return false
  const bot = ctx.bot
  bot.pathfinder.setMovements(ctx.crew.noDigMoves(bot))
  try {
    // a time limit, pathfinder.goto sometimes never settles (a !give hung for 90 s in the live test)
    await goTo(bot, new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, range), token, 30000)
  } catch (err) {
    if (token.cancelled) return false
    const near = ownerEntity(ctx)?.position.distanceTo(bot.entity.position) <= 6
    if (!near) throw err
  }
  return !token.cancelled
}

class ComeMode extends JobMode {
  constructor (ctx) { super('come', ctx, 'move') }

  async run (token) {
    if (!ownerEntity(this.ctx)) {
      this.ctx.crew.say(this.ctx.bot, `I can't see you, ${this.ctx.crew.owner}`)
      return 'far'
    }
    await walkToOwner(this.ctx, token, 2)
    return 'done'
  }

  describe () { return 'coming to you' }
}

class GiveMode extends JobMode {
  constructor (ctx) { super('give', ctx, 'move') }

  async run (token) {
    const { bot, crew } = this.ctx
    if (!ownerEntity(this.ctx)) {
      crew.say(bot, `I can't see you, ${crew.owner}`)
      return 'far'
    }
    if (!await walkToOwner(this.ctx, token, 2)) return 'cancelled'
    const owner = ownerEntity(this.ctx)
    if (owner) await bot.lookAt(owner.position.offset(0, 1.2, 0), true)
    // tools, weapons, armor, torches and some food stay with the bot
    const keepFood = foods(bot)[0]?.item
    const items = bot.inventory.items().filter(i => !KEEP.test(i.name) && i !== keepFood)
    if (!items.length) {
      crew.say(bot, 'Nothing to give')
      return 'done'
    }
    let n = 0
    for (const item of items) {
      if (token.cancelled) return 'cancelled'
      await bot.tossStack(item)
      n += item.count
    }
    crew.say(bot, `Dropped ${n} items`)
    return 'done'
  }

  describe () { return 'bringing you items' }
}

class MineMode extends JobMode {
  constructor (ctx) { super('mine', ctx, 'mine') }

  onStart () {
    // strategy 'old' is the earlier single tunnel miner, kept for the mining benchmark (crew.js --miner old)
    this.job = {
      block: this.params.block,
      blocks: this.params.blocks,
      count: this.params.count,
      mined: 0,
      strategy: this.ctx.crew.miner === 'old' ? 'old' : 'new',
      home: null
    }
  }

  async run (token) {
    const { bot, crew, human } = this.ctx
    const job = this.job
    // a long job starts with enough food in the bag
    if (!job.fedCheck) {
      job.fedCheck = true
      if (foodPointsCarried(bot) < ENOUGH_FOOD) {
        crew.event(bot, 'normal', 'gather', 'Little food on me, getting some first')
        bot.pathfinder.setMovements(crew.noDigMoves(bot))
        const got = await gatherFood(bot, token, crew.log)
        if (token.cancelled) return 'cancelled'
        if (foodPointsCarried(bot) < ENOUGH_FOOD) crew.event(bot, 'normal', 'gather', got > 0 ? 'Got a little food, mining now' : 'Could not get any food, mining anyway')
      }
    }
    bot.pathfinder.setMovements(crew.digMoves(bot))
    const r = await mineJob(bot, job, human, token, {
      say: text => crew.event(bot, 'normal', 'mine-note', text, 30000),
      log: crew.log,
      onMined: j => {
        const valuable = VALUABLE.has(j.block)
        crew.event(bot, valuable ? 'normal' : 'detail', `mined-${j.mined}`, `Found ${j.block} (${j.mined}/${j.count})`, 0)
      }
    })
    if (token.cancelled) return 'cancelled'
    if (r.message) crew.event(bot, 'key', `mine-${r.result}`, r.message, 0)
    if (r.result === 'full') setTimeout(() => this.ctx.manager.setOn('give', {}), 0)
    return r.result
  }

  describe () { return `mining ${this.job.block} ${this.job.mined}/${this.job.count}` }
}

// What the build and farm jobs need from the crew: chat, the log, the builds it knows, and the miner for coal
function jobHooks (ctx) {
  const { bot, crew, human } = ctx
  return {
    say: text => crew.event(bot, 'normal', 'job-note', text, 0),
    log: crew.log,
    builds: () => crew.builds.list(),
    farms: () => crew.farms(),
    register: job => crew.builds.add(bot, job),
    mine: async (blocks, count, token) => {
      const job = { block: blocks[0].replace(/^deepslate_/, '').replace(/_ore$/, ''), blocks, count, mined: 0, strategy: crew.miner, home: null, store: false }
      bot.pathfinder.setMovements(crew.digMoves(bot))
      try {
        await mineJob(bot, job, human, token, { say: t => crew.event(bot, 'normal', 'mine-note', t, 30000), log: crew.log })
      } finally {
        bot.pathfinder.setMovements(crew.buildMoves(bot))
      }
      return job.mined
    }
  }
}

// Builds a blueprint (and !expand, which builds the bigger blueprint over the old one)
class BuildMode extends JobMode {
  constructor (ctx) { super('build', ctx, 'build') }

  onStart () {
    this.job = { blueprint: this.params.blueprint, anchor: this.params.anchor, facing: this.params.facing, modules: this.params.modules || 1, crop: this.params.crop || null }
  }

  async run (token) {
    const { bot, crew } = this.ctx
    this.job.hooks = jobHooks(this.ctx)
    bot.pathfinder.setMovements(crew.buildMoves(bot))
    const r = await buildJob(bot, this.job, token)
    if (token.cancelled) return 'cancelled'
    if (r.message) crew.event(bot, 'key', `build-${r.result}`, r.message, 0)
    return r.result
  }

  describe () { return `building ${this.job?.blueprint?.name}, ${this.job?.stats?.placed || 0} blocks placed` }
}

// Tends a farm forever: harvest, replant, store. With here and no farm there, builds the village wheat farm first
class FarmMode extends JobMode {
  constructor (ctx) { super('farm', ctx, 'build') }

  onStart () {
    this.job = { crop: this.params.crop, here: this.params.here || null, facing: this.params.facing || null, farm: null, maxCycles: this.params.maxCycles || 0 }
  }

  async run (token) {
    const { bot, crew } = this.ctx
    const job = this.job
    job.hooks = {
      ...jobHooks(this.ctx),
      build: async (name, anchor, facing, tok, crop) => {
        const b = crew.loadBlueprint(name)
        if (!b) return { result: 'unknown', message: `I have no blueprint called ${name}` }
        const bjob = { blueprint: b, anchor, facing: facing || b.facing, modules: 1, crop, hooks: jobHooks(this.ctx) }
        this.buildJob = bjob
        const r = await buildJob(bot, bjob, tok)
        if (r.message && !tok.cancelled) crew.event(bot, 'key', `build-${r.result}`, r.message, 0)
        return { ...r, record: bjob.record || null }
      }
    }
    bot.pathfinder.setMovements(crew.buildMoves(bot))
    const r = await farmJob(bot, job, token)
    if (token.cancelled) return 'cancelled'
    if (r.message) crew.event(bot, 'key', `farm-${r.result}`, r.message, 0)
    return r.result
  }

  describe () {
    const s = this.job?.stats
    return `farming ${this.job?.crop}${s ? `, ${s.harvested} harvested, ${s.stored} stored` : ''}`
  }
}

class ExploreMode extends JobMode {
  constructor (ctx) { super('explore', ctx, 'move') }

  onStart () {
    this.job = { radius: this.params.radius, start: null, found: [] }
  }

  async run (token) {
    const { bot, crew, human } = this.ctx
    bot.pathfinder.setMovements(crew.noDigMoves(bot))
    const r = await exploreJob(bot, this.job, human, token, {
      say: (text, o = {}) => crew.event(bot, 'normal', o.key || 'explore-note', text, 0),
      log: crew.log,
      moves: crew.noDigMoves(bot)
    })
    if (token.cancelled) return 'cancelled'
    if (r.message) crew.event(bot, 'key', `explore-${r.result}`, r.message, 0)
    return r.result
  }

  describe () { return `exploring within ${this.job?.radius}, ${this.job?.found?.length || 0} finds` }
}

class FollowMode extends Mode {
  constructor (ctx) {
    super('follow')
    this.profile = 'move'
    this.ctx = ctx
    this.following = null
  }

  wants () { return !!ownerEntity(this.ctx) }

  enter () { this.following = null }

  update () {
    const owner = ownerEntity(this.ctx)
    if (!owner || owner === this.following) return
    const bot = this.ctx.bot
    bot.pathfinder.setMovements(this.ctx.crew.noDigMoves(bot))
    bot.pathfinder.setGoal(new goals.GoalFollow(owner, 2), true)
    this.following = owner
  }

  exit () {
    this.following = null
    this.ctx.bot.pathfinder.setGoal(null)
  }

  describe () { return 'following you' }
}

class IdleMode extends Mode {
  constructor () {
    super('idle')
    this.always = true
  }
}

function makeModes (ctx) {
  const manager = new ModeManager([
    new KillMode(ctx),
    new RetreatMode(ctx),
    new GuardMode(ctx),
    new EatMode(ctx),
    new GiveMode(ctx),
    new ComeMode(ctx),
    new BuildMode(ctx),
    new MineMode(ctx),
    new ExploreMode(ctx),
    new FarmMode(ctx),
    new FollowMode(ctx),
    new IdleMode()
  ], {
    log: text => ctx.crew.log(`${ctx.bot.username}: ${text}`),
    stopAll: () => ctx.crew.stopAll(ctx.bot),
    profileChanged: (prev, next) => ctx.crew.profileChanged(ctx, prev, next)
  })
  ctx.manager = manager
  return manager
}

module.exports = { makeModes, KillMode, GuardMode, RetreatMode, EatMode, MineMode, BuildMode, FarmMode, ExploreMode, FollowMode, ComeMode, GiveMode, IdleMode, KEEP, jobHooks }
