// One fighter: what it can see of the fight, and how an action becomes key presses.
//
// Fairness rules, so the bot plays by what a real client can do:
//   it only reads what its own Minecraft client receives (no server-side secrets)
//   a hit only lands if the crosshair ray actually touches the enemy hitbox within reach
//   clicking while the shield is up does nothing (and does not reset the swing charge), like vanilla
//   camera turns are capped per step (a fast human flick, not an instant snap)

const { Vec3 } = require('vec3')
const { toNotchianYaw, toNotchianPitch } = require('mineflayer/lib/conversions')
const { HealthEstimate, APPLES, EAT_TICKS, meleeDamage, arrowDamage } = require('./fair_health')

const REACH = 3.0
const EYE = 1.62
const PLAYER_W = 0.6
const PLAYER_H = 1.8
const SHIELD_DISABLE_TICKS = 100
// A raised shield only starts blocking after 5 ticks (0.25 s), per the Minecraft Wiki
const SHIELD_DELAY_TICKS = 5
// A raise the server did not take (the shield's item cooldown from a disable in the last 5 s of the previous round, which
// the round reset forgets) shows as our own hand staying inactive, checked after this many ticks (agent B)
const SHIELD_RESYNC_TICKS = 4

// Action layout, shared with Python through the init reply
//   0 forward/back   0 none, 1 W, 2 S
//   1 strafe         0 none, 1 A, 2 D
//   2 sprint         0/1
//   3 jump           0/1
//   4 turn left/right, index into YAW_STEPS (degrees, up to a 180 flick)
//   5 look up/down,    index into PITCH_STEPS (degrees)
//   6 attack         0 none, 1 click, 2 double click (second click one tick later, for stuns)
//   7 use (right click, hold). With the crossbow in hand it charges the crossbow (hold 1.25 s
//                    then let go to load it) or fires it when loaded, like vanilla. Otherwise it
//                    raises the shield. Attack and shield in the same step swings first, then raises
//                    the shield (the "insta shield" from the tutorials)
//   8 weapon         0 keep, 1 axe, 2 sword, 3 crossbow
//   9 sneak          0/1
//  10 lock aim       0/1, look exactly where an arrow fired now would meet the target instead of this step's
//                    turns (DEC-030), only with the crossbow or the bow in hand
const YAW_STEPS = [-90, -45, -20, -10, -4, -1.5, 0, 1.5, 4, 10, 20, 45, 90, 180, -0.5, 0.5, -0.25, 0.25]  // fine turns at the end, beyond 9 blocks (sim/constants.py)
const PITCH_STEPS = [-40, -20, -8, -3, -1, 0, 1, 3, 8, 20, 40, -0.5, 0.5, -0.25, 0.25]
// weapon (8): 0 keep, 1 axe, 2 sword, 3 crossbow, 4 bow (the bow joined with the MCTiers axe kit)
const ACTION_DIMS = [3, 3, 2, 2, YAW_STEPS.length, PITCH_STEPS.length, 3, 2, 5, 2, 2]
const IDLE_ACTION = [0, 0, 0, 0, YAW_STEPS.indexOf(0), PITCH_STEPS.indexOf(0), 0, 0, 0, 0, 0]
const SLOT_AXE = 0
const SLOT_SWORD = 1
const SLOT_CROSSBOW = 2
const SLOT_BOW = 3
// Bow: draw by holding use, shoot on release (a draw under 3 ticks shoots nothing), full power at 20 ticks
const BOW_FULL_TICKS = 20
const BOW_MIN_TICKS = 4  // sim/constants.py: from 4 client ticks the server always shoots, shorter draws are cancelled
const CROSSBOW_CHARGE_TICKS = 25
const ARROWS = 6  // MCTiers axe kit, shared by the bow and the crossbow
// DEC-091 (pvpbot/aim.py), each off unless its variable is 1. AXEBOT_LEAD: the lead takes the velocity over 2 whole
// position update periods (a player's position comes every 2 ticks, a mob's every 3, so the old 3 tick window read
// 2/3 or 4/3 of the speed) and lets the target move on for the age of what we see before the flight starts.
// AXEBOT_AIM_OFFSET: with lock aim at the shooting expert's range the fine steps are offsets around the lead
const LEAD_ON = process.env.AXEBOT_LEAD === '1'
const AIM_OFFSET_ON = process.env.AXEBOT_AIM_OFFSET === '1'
// FIND-041 (scan): the server's shield cooldown from a disable in the last 5 s of a round outlives the round,
// so with this flag reset() keeps counting it down (a death clears it, a respawned player has no item cooldown).
// Off by default until a real shield_axe probe confirms it, the real L1 reads it only at its next start
const SHIELD_CARRY = process.env.AXEBOT_SHIELD_CARRY === '1'
const LEAD_PERIODS = 2
const LEAD_HIST = 8
const LEAD_LATENCY = Number(process.env.AXEBOT_LEAD_LATENCY ?? 0.5)
const OFFSET_YAW_MAX = 4
const OFFSET_PITCH_MAX = 3
const EXPERT_RANGE = 4.5  // pvpbot/skills.py RANGE, where the shooting expert takes over
// A shot that has not hit anything after 2 s missed. How the shooter moved at the shot, from its horizontal speed in
// blocks a tick (the same limits as sim/constants.py MOVE_STILL_SPEED and MOVE_WALK_SPEED)
const SHOT_MISS_TICKS = 40
const MOVE_STILL_SPEED = 0.03
const MOVE_WALK_SPEED = 0.2
// Arrows lying near the bot (sim/constants.py): it sees the nearest within 4 blocks that a player could reach, from
// 1 block below its feet to half a block over its head. An arrow is lying once its in_ground flag (metadata 10 on
// 1.21.11) is set, and its spot is known once a position update came after that, or after 20 ticks (the server
// sends an arrow's position once a second and Mineflayer does not move it in between)
const ARROW_IN_GROUND = 10
const ARROW_SPOT_TICKS = 20
const ARROW_SEE_BLOCKS = 4
// Something to block right now (sim/constants.py THREAT_REACH): the shield is free then and costs a little otherwise
const THREAT_REACH = 4.5
const PICKUP_BELOW = 1.0
const PICKUP_ABOVE = 0.5
// Local crossbow and arrow state that disagrees with the server's inventory for this long is replaced by it
const DESYNC_TICKS = 20  // 1 s, so a slow server tick does not count

// Ticks for a full swing charge (20 / attack speed): axe 1.0, sword 1.6, fist 4.0
const CHARGE_TICKS = { axe: 20, sword: 12.5, crossbow: 5, bow: 5, none: 5 }

// Terrain the bot can see: a 7 by 7 grid of cells around it, turned to face where it looks
const GRID = 3
// plus 4 inputs reserved for strategy letters (phase and so on), zeros for now
// 9 ranged slots (crossbow 5, bow 2, enemy bow and loading 2) and 7 shooting slots (the clear line of
// fire added later, sim/constants.py), 3 for the nearest arrow on the ground
// and 1 for the enemy holding a loaded crossbow (sim/constants.py)
const OBS_DIM = 49 + (2 * GRID + 1) ** 2 + 3 + 9 + 7 + 3 + 1 + 4
// Idea 40 (pvpbot/sim/blockgrid.py, the same numbers in the same order): the blocks around the fighter and around the
// enemy it sees, both turned to its own look, 5 by 5 cells by 9 levels (4 under the feet block to 4 above it). Own grid
// first, the lowest level first, the front row first, left to right. 1 a full block, 0.5 a bottom slab, 0 open, water
// or a cobweb, -1 lava or fire. Only for a version trained with it (blockGridInput, bridge.js block_grid)
const GRID_R = 2
const GRID_LEVELS = [-4, -3, -2, -1, 0, 1, 2, 3, 4]
const GRID_INPUTS = 2 * (2 * GRID_R + 1) ** 2 * GRID_LEVELS.length
const FEET_EPS = 0.01

function gridCell (block) {
  if (!block) return 0
  if (block.name === 'lava' || block.name === 'fire') return -1
  if (block.boundingBox !== 'block') return 0
  let top = 0
  for (const s of block.shapes || []) top = Math.max(top, s[4])
  return top
}

// blockAt(x, y, z) takes whole block coordinates, me and enemy are feet positions (the enemy where this bot sees it)
function blockGrid (blockAt, me, yaw, enemy) {
  const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
  const r = { x: Math.cos(yaw), z: -Math.sin(yaw) }
  const out = []
  for (const c of [me, enemy]) {
    if (!c) {
      for (let k = 0; k < GRID_INPUTS / 2; k++) out.push(0)
      continue
    }
    const by = Math.floor(c.y + FEET_EPS)
    for (const dy of GRID_LEVELS) {
      for (let i = GRID_R; i >= -GRID_R; i--) {
        for (let j = -GRID_R; j <= GRID_R; j++) {
          out.push(gridCell(blockAt(Math.floor(c.x + f.x * i + r.x * j), by + dy, Math.floor(c.z + f.z * i + r.z * j))))
        }
      }
    }
  }
  return out
}

const ARROW_SPEED = 3.15
const BOW_SPEED = 3.0
const ARROW_GRAVITY = 0.05
const ARROW_HIT_INFLATE = 0.3

const rad = d => d * Math.PI / 180
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))
const freshEvents = () => ({
  hits: 0, swings: 0, crits: 0, blocked: 0, shieldBreaks: 0, toggles: 0,
  myBlocks: 0, autoHits: 0, autoCrits: 0, comboHits: 0, jumpResets: 0, whiffPunish: 0,
  backHits: 0, myShieldBroken: 0, shots: 0, arrowHits: 0, arrowMisses: 0, arrowCombos: 0, arrowHitMe: 0,
  swordHits: 0, fullHits: 0, fullSwordHits: 0, arrowsBlocked: 0, enemyHits: 0, enemyCrits: 0, arrowsWasted: 0, enemyArrowPickups: 0,
  fullDraws: 0, shotsBow: 0, arrowHitsBow: 0, arrowHitsWeakBow: 0, arrowHitsFull: 0, arrowsWastedBow: 0, arrowHitMeBow: 0, arrowsBlockedBow: 0,
  arrowHitMeDown: 0, arrowHitMeLate: 0, arrowHitMeSide: 0, loads: 0, shotResults: [], shotAim: null, strayShots: 0, phantomShots: 0, phantomNote: '', desyncs: 0, desyncNote: '', arrowPickups: 0
})

// Launch angle and flight ticks on the real arrow tick rule (move, speed times 0.99, 0.05 down), the same as
// sim/observe.py arrow_path(). The textbook drop aimed long shots about 1 degree high.
function arrowPath (dh, dy, speed, theta) {
  let k = 0
  for (let i = 0; i < 4; i++) {
    const vh = speed * Math.cos(theta)
    const q = Math.max(1 - dh / (100 * Math.max(vh, 1e-3)), 0.05)
    k = Math.log(q) / Math.log(0.99)
    const vy = (dy + 5 * k) / (100 * (1 - q)) - 5
    theta = Math.atan2(vy, vh)
  }
  return [theta, k]
}

// Where an arrow fired now would meet the target, the same math as sim/observe.py ballistics(): the weapon's
// speed (crossbow 3.15, bow 3 times the draw power, full power assumed until drawing), the target moving on for the
// flight time, the drop, and a bow arrow carrying the shooter's movement (vanilla, a crossbow arrow does not)
// extra (DEC-091, AXEBOT_LEAD): ticks the target moves on at its own velocity before the arrow leaves
function ballistics (d, ev, mv, yaw, pitch, bow, drawing, bowTicks, onGround, enemyY, enemyGround, extra = 0) {
  const f = drawing ? Math.min(bowTicks / BOW_FULL_TICKS, 1) : 1
  const power = Math.min((f * f + 2 * f) / 3, 1)
  const speed = bow ? BOW_SPEED * Math.max(power, 0.1) : ARROW_SPEED
  const r = { x: ev.x - (bow ? mv.x : 0), y: ev.y - (bow && !onGround ? mv.y : 0), z: ev.z - (bow ? mv.z : 0) }
  const dy = d.y + 0.1  // arrows leave 0.1 below the eye
  d = { x: d.x + ev.x * extra, y: d.y, z: d.z + ev.z * extra }
  let t = Math.hypot(d.x, dy, d.z) / speed
  let theta = Math.atan2(dy, Math.hypot(d.x, d.z))
  let p, ph
  const floor = Math.min(enemyY, 100)
  for (let i = 0; i < 3; i++) {
    // on the ground it stays at its height, in the air it falls (0.08 a tick squared) and stops at the floor
    const fall = enemyGround ? 0 : r.y * t - 0.04 * t * t
    const rise = Math.max(enemyY + fall, floor) - enemyY
    p = { x: d.x + r.x * t, y: dy + rise, z: d.z + r.z * t }
    ph = Math.max(Math.hypot(p.x, p.z), 0.5);
    [theta, t] = arrowPath(ph, p.y, speed, theta)
  }
  const leadYawErr = wrap(Math.atan2(-p.x, -p.z) - yaw)
  const leadPitchErr = theta - pitch
  const half = Math.atan((0.3 + ARROW_HIT_INFLATE) / ph)
  const halfH = Math.atan((PLAYER_H / 2 + ARROW_HIT_INFLATE) / ph)  // vertically in target heights (BUG-028)
  // too weak to get there (a short bow draw): no real aim point, judged far off (BUG-033, sim/observe.py)
  const reach = 1 - ph / (100 * Math.max(speed * Math.cos(theta), 1e-3)) > 0.05 && theta < 1.4
  return {
    leadYawErr,
    leadPitchErr,
    aimWidths: reach ? Math.abs(leadYawErr) / half : 99,
    aimHeights: reach ? Math.abs(leadPitchErr) / halfH : 99,
    flightTicks: t
  }
}

function weaponOf (item) {
  if (!item) return 'none'
  if (item.name.endsWith('_axe')) return 'axe'
  if (item.name.endsWith('_sword')) return 'sword'
  if (item.name === 'crossbow') return 'crossbow'
  if (item.name === 'bow') return 'bow'
  return 'none'
}

// Distance along the ray to the box, or null if it misses (slab method).
function rayBox (origin, dir, min, max) {
  let tmin = -Infinity
  let tmax = Infinity
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(dir[k]) < 1e-9) {
      if (origin[k] < min[k] || origin[k] > max[k]) return null
      continue
    }
    const t1 = (min[k] - origin[k]) / dir[k]
    const t2 = (max[k] - origin[k]) / dir[k]
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  return Math.max(tmin, 0)
}

// Shortest distance from a point to a player's hitbox (how reach is measured)
function pointBoxDistance (p, pos) {
  const w = PLAYER_W / 2
  const dx = Math.max(pos.x - w - p.x, 0, p.x - pos.x - w)
  const dy = Math.max(pos.y - p.y, 0, p.y - pos.y - PLAYER_H)
  const dz = Math.max(pos.z - w - p.z, 0, p.z - pos.z - w)
  return Math.hypot(dx, dy, dz)
}

function lookDir (yaw, pitch) {
  return {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch)
  }
}

// Calls fn(name, position) for every sound this client hears.
// Mineflayer's sound names are one entry off for 1.21.11 (checked: a sword hit on a raised
// shield arrives as id 1394, which the 1.21.11 table lists one slot earlier than item.shield.block),
// so this reads the raw packet and shifts the lookup.
const SOUND_ID_SHIFT = 1
function onSound (bot, fn) {
  bot._client.on('sound_effect', p => {
    const name = p.sound?.data?.soundName ?? bot.registry.sounds[(p.sound?.soundId ?? p.soundId) + SOUND_ID_SHIFT]?.name ?? ''
    fn(name, { x: p.x / 8, y: p.y / 8, z: p.z / 8 })
  })
}

const near = (pos, e) => e && Math.hypot(pos.x - e.position.x, pos.y - e.position.y, pos.z - e.position.z) < 1.5

// What this client can see of the other player, tracked tick by tick.
class EnemyView {
  constructor (bot, username) {
    this.bot = bot
    this.username = username
    this.reset()

    bot.on('physicsTick', () => this.tick())
    bot.on('entitySwingArm', e => { if (e === this.entity()) this.ticksSinceSwing = 0 })
    bot.on('entityDead', e => { if (e === this.entity()) this.dead = true })
    bot.on('entityEquip', e => {
      if (e !== this.entity()) return
      const w = weaponOf(e.heldItem)
      if (w !== this.lastWeapon) this.ticksSinceSwitch = 0
      this.lastWeapon = w
    })
    onSound(bot, (name, pos) => {
      // Only theirs when nearer to them than to us: a zombie hugging us made our own shield break count as theirs
      const e = this.entity()
      const me = bot.entity.position
      const closer = e && Math.hypot(pos.x - e.position.x, pos.y - e.position.y, pos.z - e.position.z) <
        Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z)
      if (name === 'item.shield.break' && closer && near(pos, e)) this.shieldCooldown = SHIELD_DISABLE_TICKS
    })
  }

  // Players are found by name. A mob opponent (the zombie) sets lookup instead.
  entity () {
    if (this.lookup) return this.lookup()
    return this.bot.players[this.username]?.entity ?? null
  }

  tick () {
    this.ticksSinceSwing++
    this.ticksSinceSwitch++
    if (this.shieldCooldown > 0) this.shieldCooldown--
    this.shieldTicks = this.shieldUp() ? this.shieldTicks + 1 : 0
    const e = this.entity()
    if (!e) return
    // Position packets do not line up exactly with our ticks, so average over the last few
    this.history.push(e.position.clone())
    if (this.history.length > 4) this.history.shift()
    const first = this.history[0]
    const n = this.history.length - 1
    if (n > 0) this.vel = { x: (e.position.x - first.x) / n, y: (e.position.y - first.y) / n, z: (e.position.z - first.z) / n }
    if (LEAD_ON) this.leadTick(e)
  }

  // DEC-091 AXEBOT_LEAD (pvpbot/aim.py LeadTracker): the velocity over 2 whole update periods, and the ticks since
  // the seen position last changed
  leadTick (e) {
    const last = this.leadHistory[this.leadHistory.length - 1]
    this.sinceMove = !last || !last.equals(e.position) ? 0 : this.sinceMove + 1
    this.leadHistory.push(e.position.clone())
    if (this.leadHistory.length > LEAD_HIST) this.leadHistory.shift()
    const L = LEAD_PERIODS * this.period()
    const k = this.leadHistory.length - 1 - L
    if (k < 0) {
      this.leadVel = this.vel
      return
    }
    const f = this.leadHistory[k]
    this.leadVel = { x: (e.position.x - f.x) / L, y: (e.position.y - f.y) / L, z: (e.position.z - f.z) / L }
  }

  // ticks between position updates: a mob's come every 3, a player's every 2
  period () {
    return this.lookup ? 3 : 2
  }

  // the velocity the lead uses and the ticks the target moves on before the arrow leaves
  leadInputs () {
    if (!LEAD_ON) return { vel: this.vel, extra: 0 }
    return { vel: this.leadVel, extra: Math.min(this.sinceMove, this.period() - 1) + LEAD_LATENCY }
  }

  health () {
    const h = this.entity()?.metadata?.[9]
    return typeof h === 'number' ? h : null
  }

  // "Using an item" is one flag for the shield, a crossbow load and a bow draw, the held item tells them apart.
  // At first a loading enemy counted as blocking.
  handActive () {
    return ((this.entity()?.metadata?.[8] ?? 0) & 1) === 1
  }

  // The item in the hand being used (bit 2 of the living flags is the offhand), for seeing them eat (DEC-076)
  usedItem () {
    const e = this.entity()
    if (!e || !this.handActive()) return null
    const offhand = ((e.metadata?.[8] ?? 0) & 2) === 2
    return (offhand ? e.equipment?.[1] : e.heldItem)?.name ?? null
  }

  holdsRanged () {
    const w = weaponOf(this.entity()?.heldItem)
    return w === 'crossbow' || w === 'bow'
  }

  // The used item must be the shield: an enemy eating (a golden apple in the active main hand, DEC-076) used to read
  // as a raised shield here, which hid him from the arrows and the hit rewards (a check by agent B)
  shieldUp () {
    return this.handActive() && !this.holdsRanged() && this.usedItem() === 'shield' && this.shieldCooldown <= 0
  }

  rangedUse () {
    return this.handActive() && this.holdsRanged()
  }

  // Holding a crossbow with an arrow in it (the item's charged_projectiles component, sent with the equipment)
  crossbowLoaded () {
    const item = this.entity()?.heldItem
    if (item?.name !== 'crossbow') return false
    const c = (item.components ?? []).find(x => x.type === 'charged_projectiles')
    return (c?.data?.projectiles ?? c?.data ?? []).length > 0
  }

  // Raised long enough to actually block
  shieldActive () {
    return this.shieldUp() && this.shieldTicks >= SHIELD_DELAY_TICKS
  }

  sprinting () {
    return ((this.entity()?.metadata?.[0] ?? 0) & 0x08) !== 0
  }

  // Mineflayer never updates onGround for other players, so judge it from their height not changing
  onGround () {
    return this.history.length >= 2 && Math.abs(this.vel.y) < 0.005
  }

  // Their swing charge is not sent to us, so estimate it from their last swing and weapon switch
  chargeEstimate () {
    const w = weaponOf(this.entity()?.heldItem)
    return clamp((Math.min(this.ticksSinceSwing, this.ticksSinceSwitch) + 0.5) / CHARGE_TICKS[w], 0, 1)
  }

  reset () {
    this.history = []
    this.vel = { x: 0, y: 0, z: 0 }
    this.leadHistory = []
    this.leadVel = { x: 0, y: 0, z: 0 }
    this.sinceMove = 0
    this.ticksSinceSwing = 100
    this.ticksSinceSwitch = 100
    this.lastWeapon = null
    this.shieldCooldown = SHIELD_CARRY && !this.dead ? Math.max(this.shieldCooldown || 0, 0) : 0
    this.shieldTicks = 0
    this.dead = false
  }
}

class Fighter {
  constructor (bot, enemyName) {
    this.bot = bot
    this.enemy = new EnemyView(bot, enemyName)
    // Fair health (DEC-076): off unless the bridge turns it on, and then only the enemyHp input changes
    this.fairHealth = false
    this.kindInput = false  // the enemy kind input (FIND-023), on for a version trained with it
    this.blockGridInput = false  // the block grid inputs (idea 40), on for a version trained with them
    this.hpEst = new HealthEstimate()
    this.reset(false)

    bot.on('physicsTick', () => this.tick())
    if (SHIELD_CARRY) bot.on('death', () => { this.shieldCooldown = 0 })
    bot._client.on('set_cooldown', p => {
      if (/shield/.test(p.cooldownGroup ?? '') && p.cooldownTicks > 0) {
        this.shieldCooldown = p.cooldownTicks
        this.shieldUp = false
        this.ticksSinceShieldDisabled = 0
        this.events.myShieldBroken++
      }
    })
    bot.on('entityHurt', e => {
      if (e === bot.entity) {
        this.ticksSinceHitMe = 0
        this.combo = 0
        this.hitSinceMyHit = true
      } else if (e && e === this.enemy.entity()) {
        this.ticksSinceIHit = 0
        this.combo = this.hitSinceMyHit ? 1 : this.combo + 1
        if (this.combo >= 2) this.events.comboHits++
        this.hitSinceMyHit = false
        if (this.ticksSinceEnemyWhiff <= 20) {
          this.events.whiffPunish++
          this.ticksSinceEnemyWhiff = 100
        }
      }
    })
    // Fair health (DEC-076): a damage event on the enemy from our swing or our arrow is a full hit. Registered before
    // the arrow handler below, which takes the shot out of the list
    // Their crits on us (recording only): the server sends the crit particle animation on the entity hit,
    // mineflayer emits it as entityCriticalEffect
    bot.on('entityCriticalEffect', e => { if (e === bot.entity && this.enemy.entity()) this.events.enemyCrits++ })
    bot._client.on('damage_event', p => {
      const enemy = this.enemy.entity()
      if (!this.fairHealth || !enemy || p.entityId !== enemy.id) return
      if (p.sourceDirectId - 1 === bot.entity.id) {
        if (this.pendingMelee) this.hpEst.hit(this.pendingMelee.amount, false, true)
        this.pendingMelee = null
        return
      }
      const direct = bot.entities[p.sourceDirectId - 1]
      const shot = direct?.name === 'arrow' ? this.shots.find(s => s.id === direct.id) : null
      if (shot) this.hpEst.hit(this.shotDamage(shot), false, true)
    })
    // Each shot is matched with its own arrow entity (BUG-018: a hit used to resolve the oldest arrow in flight,
    // which moved hits between distance bands). An arrow's spawn packet carries its owner's entity id (1.21.11,
    // checked on our server)
    bot._client.on('spawn_entity', p => {
      if (p.type !== bot.registry.entitiesByName.arrow?.id) return
      if (p.objectData === this.enemy.entity()?.id) this.enemyArrows.add(p.entityId)  // for threat()
      if (p.objectData !== bot.entity.id) return
      const shot = this.shots.find(s => s.id === null)
      if (shot) shot.id = p.entityId
      else this.events.strayShots++  // the server shot an arrow the bot never counted (BUG-019)
    })
    bot._client.on('damage_event', p => {
      const direct = bot.entities[p.sourceDirectId - 1]
      if (direct?.name !== 'arrow') return
      const enemy = this.enemy.entity()
      if (enemy && p.entityId === enemy.id) {
        this.events.arrowHits++
        this.events.arrowHitsFull++  // a damage event is a full hit, partial ones are found by the tick check (BUG-095)
        const i = this.shots.findIndex(s => s.id === direct.id)
        if (i >= 0 && this.shots[i].weapon.startsWith('bow')) {
          this.events.arrowHitsBow++
          // a bow arrow short of a full draw is not paid as an arrow hit (BUG-093, sim/combat.py arrow_hits_weak_bow)
          if (this.shots[i].bowTicks < BOW_FULL_TICKS) this.events.arrowHitsWeakBow++
        }
        if (i >= 0) this.resolveShot(i, 1)
        if (this.ticksSinceMeleeHit <= 20) this.events.arrowCombos++
      } else if (p.entityId === bot.entity.id) {
        this.events.arrowHitMe++
        if (weaponOf(enemy?.heldItem) === 'bow') this.events.arrowHitMeBow++
        // why it was not blocked: shield down, raised under 5 ticks, or the arrow from the back half
        if (!this.shieldUp) this.events.arrowHitMeDown++
        else if (this.shieldTicks < SHIELD_DELAY_TICKS) this.events.arrowHitMeLate++
        else this.events.arrowHitMeSide++
      }
    })
    // The enemy's melee hits on us (axe, sword or a zombie): damage whose direct source is the enemy itself
    bot._client.on('damage_event', p => {
      const enemy = this.enemy.entity()
      if (enemy && p.entityId === bot.entity.id && p.sourceDirectId - 1 === enemy.id) this.events.enemyHits++
    })
    // Walking over an arrow on the ground picks it up (vanilla), counted at once so the arrow count never waits for
    // the inventory check
    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity || collected?.name !== 'arrow') return
      this.arrows++
      this.events.arrowPickups++
      if (this.enemyArrows.has(collected.id)) this.events.enemyArrowPickups++  // only these earn the reward
    })
    // An enemy swing with no hit on us a few ticks later is a whiff (swung at air)
    bot.on('entitySwingArm', e => { if (e && e === this.enemy.entity()) this.whiffCheck = 4 })
    onSound(bot, (name, pos) => {
      if (name !== 'item.shield.break' && name !== 'item.shield.block') return
      // Up close both players are within range of the sound, so give it to the nearer one
      const e = this.enemy.entity()
      const dist = ent => ent ? Math.hypot(pos.x - ent.position.x, pos.y - ent.position.y, pos.z - ent.position.z) : 99
      const theirs = dist(e) < dist(bot.entity)
      if (theirs && dist(e) < 1.5) {
        // fair health: their shield took our swing or arrow, a full hit that deals 0 and starts the hurt window
        if (this.fairHealth && (this.pendingMelee || name === 'item.shield.block')) {
          this.hpEst.hit(0, true, true)
          this.pendingMelee = null
        }
        if (name === 'item.shield.break') this.events.shieldBreaks++
        // their shield stopped one of our arrows when we are out of melee reach (the simulator's arrows_wasted)
        else if (e && Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z) > THREAT_REACH) {
          this.events.arrowsWasted++
          if (this.shots.length && this.shots[this.shots.length - 1].weapon.startsWith('bow')) this.events.arrowsWastedBow++
        } else this.events.blocked++
      } else if (!theirs && dist(bot.entity) < 1.5 && name === 'item.shield.block') {
        this.events.myBlocks++
        this.ticksSinceMyBlock = 0
        // the enemy out of melee reach or holding a bow or crossbow: it was an arrow (the simulator counts
        // arrows_blocked directly, an audit found point blank crossbow blocks filed as melee), else melee
        if (!e || this.enemy.holdsRanged() ||
          Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z) > THREAT_REACH) {
          this.events.arrowsBlocked++
          if (weaponOf(e?.heldItem) === 'bow') this.events.arrowsBlockedBow++
        } else {
          this.events.enemyHits++
        }
      }
    })
  }

  tick () {
    this.ticksSinceSwing++
    this.ticksSinceIHit++
    this.ticksSinceHitMe++
    this.ticksSinceShieldDisabled++
    this.ticksSinceEnemyWhiff++
    this.ticksSinceMyBlock++
    if (this.shieldCooldown > 0) this.shieldCooldown--
    this.shieldTicks = this.shieldUp ? this.shieldTicks + 1 : 0
    // The server can refuse a raise (the shield on cooldown from a disable late in the previous round, since the item
    // cooldown outlives the round and reset() forgot it): the client then believed the shield was up for the whole
    // round, never asked again and never swung, while the server had it down (agent B's pvp probes: every
    // second shield_axe round). Our own entity's hand active flag says what the server did, so the client follows it
    if (this.shieldUp && this.shieldTicks >= SHIELD_RESYNC_TICKS && !this.ownHandActive()) {
      this.shieldUp = false
      this.shieldResyncs++
    }
    if (this.whiffCheck > 0 && --this.whiffCheck === 0 && this.ticksSinceHitMe > 4 && this.ticksSinceMyBlock > 4) {
      this.ticksSinceEnemyWhiff = 0
    }
    if (this.charging) this.crossbowTicks++
    // The crossbow loads once the charge is full, while use is still held (1.21.11, checked on our server).
    // The server counts the charge from when the press arrives, a tick or so after ours, so letting go right at 25
    // ticks could leave it unloaded while the bridge thought it loaded, and the next press counted a shot that
    // never left (BUG-031). So the bridge waits for the server's loaded crossbow, which shows about 2 ticks later,
    // also for a few ticks after letting go
    if (this.charging && this.crossbowTicks >= CROSSBOW_CHARGE_TICKS - 1) this.awaitLoad = 10
    this.confirmLoad()
    if (this.awaitLoad > 0 && !this.charging) this.awaitLoad--
    if (this.drawing) this.bowTicks++
    this.ticksFalling = !this.bot.entity.onGround && this.bot.entity.velocity.y < 0 ? this.ticksFalling + 1 : 0
    // the benchmark plugins raise their shields through mineflayer's activateItem, which only sets usingHeldItem, so
    // they strafed at full speed behind a shield while ours moved at 20% (Fable bridge scan, BUG-087)
    this.bot.fighterUsingItem = this.shieldUp || this.charging || this.drawing || !!this.bot.usingHeldItem
    this.ticksSinceMeleeHit++
    if (this.fairHealth) this.fairHealthTick()
    // An arrow that lands inside the enemy's hurt window does its damage with no damage event, so it used to run out
    // its timer as a miss while the simulator counts a hit (BUG-095). When our flying arrow vanishes next to them on a
    // tick their health dropped, it hit
    const hp = this.enemy.health()
    const dropped = this.prevEnemyHp != null && hp != null && hp < this.prevEnemyHp - 1e-6
    this.ticksSinceDrop = dropped ? 0 : (this.ticksSinceDrop ?? 99) + 1
    const target = this.enemy.entity()
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      if (s.id === null) continue
      if (s.gone) continue
      const arrow = this.bot.entities[s.id]
      if (arrow && arrow.metadata?.[ARROW_IN_GROUND] !== true) {
        s.flying = true
      } else if (arrow) {
        s.flying = false  // it landed in the ground, picking it up later is no hit (audit, BUG-098)
      } else if (!arrow && s.flying) {
        // decided once, the tick the flying arrow vanished (BUG-096: arrow positions arrive about once a second, so a
        // distance test almost never passed, and a later check could take our melee hit for an arrow hit)
        s.gone = true
        // fair health: gone inside their hurt window with no damage event, a hit that counts by how much it beats the last
        if (this.fairHealth && target && this.hpEst.inside()) this.hpEst.hit(this.shotDamage(s), false, false)
        // a melee hit's health update can arrive 2 to 3 ticks late, and the arrow's own one a tick after it vanishes
        if (!target || this.ticksSinceMeleeHit <= 3 || this.ticksSinceDrop > 2) continue
        this.events.arrowHits++
        if (s.weapon.startsWith('bow')) {
          this.events.arrowHitsBow++
          if (s.bowTicks < BOW_FULL_TICKS) this.events.arrowHitsWeakBow++
        }
        this.resolveShot(i, 1)
      }
    }
    this.prevEnemyHp = hp
    // A shot that has not hit anything after 2 seconds missed (one timer per arrow, quick bow shots overlap)
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      if (--s.timer <= 0 && s.id === null) {
        // no arrow ever appeared: the shot did not happen, so it is neither a hit nor a miss (BUG-031)
        this.events.phantomShots++
        this.events.phantomNote += ` ${s.weapon}`
        this.shots.splice(i, 1)
      } else if (s.timer <= 0) {
        this.events.arrowMisses++
        this.resolveShot(i, 0)
      }
    }
    this.syncWithServer()
    this.watchArrows()
    if (this.secondClick) {
      this.secondClick = false
      if (!this.shieldUp) this.swing()
    }
  }

  weapon () {
    return weaponOf(this.bot.heldItem)
  }

  // Whether the server has us using an item (the living entity flags of our own entity, bit 1), like EnemyView.handActive
  ownHandActive () {
    return ((this.bot.entity?.metadata?.[8] ?? 0) & 1) === 1
  }

  // The enemy is a mob: an arena zombie (found by lookup) or, for the crew, any entity that is not a player
  blockGrid () {
    const e = this.enemy.entity()
    return blockGrid((x, y, z) => this.bot.blockAt(new Vec3(x, y, z)), this.bot.entity.position, this.bot.entity.yaw,
      e ? e.position : null)
  }

  enemyIsMob () {
    if (this.enemy.lookup) return true
    const e = this.enemy.entity()
    return !!e && e.type !== 'player'
  }

  // Fair health (DEC-076, fair_health.js): on for a version trained with it. kind is the enemy's kind ('player', or a
  // zombie test's name), naturalRegen whether the server heals players by itself
  setFairHealth (on, kind = 'player', naturalRegen = false) {
    this.fairHealth = !!on
    this.hpEst.naturalRegen = naturalRegen
    this.hpEst.reset(kind)
    this.pendingMelee = null
    this.enemyEating = 0
  }

  fairHealthTick () {
    this.hpEst.tick()
    // a swing with no damage event or block sound after 6 ticks: inside their hurt window it may still have counted
    if (this.pendingMelee && --this.pendingMelee.ticks <= 0) {
      if (this.hpEst.inside()) this.hpEst.hit(this.pendingMelee.amount, false, false)
      this.pendingMelee = null
    }
    // eating shows as the use animation with the food in hand, a golden apple counts once eaten
    const item = this.enemy.usedItem()
    if (item && APPLES[item]) {
      if (++this.enemyEating === EAT_TICKS) this.hpEst.ate(item)
    } else this.enemyEating = 0
  }

  // The damage of one of our arrows as we can judge it (fair_health.js arrowDamage)
  shotDamage (s) {
    const bow = s.weapon.startsWith('bow')
    const f = Math.min(s.bowTicks / BOW_FULL_TICKS, 1)
    const speed = bow ? BOW_SPEED * Math.max(Math.min((f * f + 2 * f) / 3, 1), 0.1) : ARROW_SPEED
    return arrowDamage(speed, SHOT_MISS_TICKS - s.timer, !bow || s.bowTicks >= BOW_FULL_TICKS)
  }

  charge () {
    return clamp((this.ticksSinceSwing + 0.5) / CHARGE_TICKS[this.weapon()], 0, 1)
  }

  crossbowLoaded () {
    return this.loaded
  }

  crosshairOnEnemy (reach = REACH) {
    const e = this.enemy.entity()
    if (!e) return false
    const me = this.bot.entity
    const eye = me.position.offset(0, EYE, 0)
    const dir = lookDir(me.yaw, me.pitch)
    const w = PLAYER_W / 2
    const min = { x: e.position.x - w, y: e.position.y, z: e.position.z - w }
    const max = { x: e.position.x + w, y: e.position.y + PLAYER_H, z: e.position.z + w }
    const t = rayBox(eye, dir, min, max)
    if (t === null || t > reach) return false
    // A pillar between us blocks the hit, like on a real client
    const block = this.bot.blockAtCursor(t + 0.01)
    return !block || block.intersect.distanceTo(eye) >= t
  }

  // What is at a spot near us: 1 a wall, pillar or placed block, -1 lava or a hole, 0 open floor
  cell (x, z) {
    const feet = this.bot.blockAt(new Vec3(Math.floor(x), 100, Math.floor(z)))
    if (feet && feet.boundingBox === 'block') return 1
    if (feet && (feet.name === 'lava' || feet.name === 'fire')) return -1
    const floor = this.bot.blockAt(new Vec3(Math.floor(x), 99, Math.floor(z)))
    if (!floor || floor.name === 'lava' || floor.name === 'air') return -1
    return 0
  }

  terrain () {
    const me = this.bot.entity.position
    const yaw = this.bot.entity.yaw
    const f = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
    const r = { x: Math.cos(yaw), z: -Math.sin(yaw) }
    const grid = []
    let lava = null
    for (let i = GRID; i >= -GRID; i--) {
      for (let j = -GRID; j <= GRID; j++) {
        const x = me.x + f.x * i + r.x * j
        const z = me.z + f.z * i + r.z * j
        const c = this.cell(x, z)
        grid.push(c)
        const d = Math.hypot(i, j)
        if (c === -1 && (!lava || d < lava.d)) lava = { d, i, j }
      }
    }
    // Danger close to our feet in each direction, used by the scripted bots to stay out of lava
    const danger = (di, dj) => this.cell(me.x + (f.x * di + r.x * dj) * 1.2, me.z + (f.z * di + r.z * dj) * 1.2) === -1
    return {
      grid,
      lavaDist: lava ? lava.d : 5,
      lavaDir: lava ? Math.atan2(lava.j, lava.i) : 0,
      lavaAhead: danger(1, 0),
      lavaBehind: danger(-1, 0),
      lavaLeft: danger(0, -1),
      lavaRight: danger(0, 1)
    }
  }

  act (a) {
    const bot = this.bot
    const [fb, lr, sprint, jump, yawI, pitchI, attack, shield, slot, sneak, lock] = a
    const prev = this.prevAction
    if (prev[0] !== fb) this.events.toggles++
    if (prev[1] !== lr) this.events.toggles++
    if (jump === 1 && bot.entity.onGround && this.ticksSinceHitMe <= 3) this.events.jumpResets++

    bot.setControlState('forward', fb === 1)
    bot.setControlState('back', fb === 2)
    bot.setControlState('left', lr === 1)
    bot.setControlState('right', lr === 2)
    bot.setControlState('sprint', sprint === 1 && fb === 1)
    bot.setControlState('jump', jump === 1)
    bot.setControlState('sneak', sneak === 1)

    let yaw = bot.entity.yaw + rad(YAW_STEPS[yawI])
    let pitch = clamp(bot.entity.pitch + rad(PITCH_STEPS[pitchI]), -Math.PI / 2, Math.PI / 2)
    const w = this.weapon()
    const aim = lock === 1 && (w === 'crossbow' || w === 'bow') ? this.aimPoint(w === 'bow', this.drawing) : null
    if (aim) {
      // DEC-091 AXEBOT_AIM_OFFSET: at the shooting expert's range the fine steps are offsets around the lead
      const e = this.enemy.entity()
      const off = AIM_OFFSET_ON && e && Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z) >= EXPERT_RANGE
      const oy = off ? rad(clamp(YAW_STEPS[yawI], -OFFSET_YAW_MAX, OFFSET_YAW_MAX)) : 0
      const op = off ? rad(clamp(PITCH_STEPS[pitchI], -OFFSET_PITCH_MAX, OFFSET_PITCH_MAX)) : 0
      // Lock aim (DEC-030): straight to the meeting point, from what this client sees right now
      yaw = bot.entity.yaw + aim.leadYawErr + oy
      // FIND-023: a bow drawn too little to reach has no aim point (the solver points almost straight up, BUG-033), so
      // there the lock turns only sideways and keeps the chosen pitch (sim/world.py client_act, the same rule)
      if (aim.aimWidths < 99) pitch = clamp(bot.entity.pitch + aim.leadPitchErr + op, -Math.PI / 2, Math.PI / 2)
    }
    bot.look(yaw, pitch, true)

    if (slot === 1 && bot.quickBarSlot !== SLOT_AXE) this.selectSlot(SLOT_AXE)
    if (slot === 2 && bot.quickBarSlot !== SLOT_SWORD) this.selectSlot(SLOT_SWORD)
    if (slot === 3 && bot.quickBarSlot !== SLOT_CROSSBOW) this.selectSlot(SLOT_CROSSBOW)
    if (slot === 4 && bot.quickBarSlot !== SLOT_BOW) this.selectSlot(SLOT_BOW)

    // Swing first (only possible with the shield down), then handle the shield
    if (attack > 0 && !this.shieldUp && !this.charging && !this.drawing) {
      this.swing()
      if (attack === 2) this.secondClick = true
    }
    if (this.weapon() === 'crossbow') {
      this.useCrossbow(shield === 1)
    } else if (this.weapon() === 'bow') {
      this.useBow(shield === 1)
    } else if (shield === 1 && !this.shieldUp && this.shieldCooldown <= 0) {
      bot.activateItem(true)
      this.shieldUp = true
    } else if (shield === 0 && this.shieldUp) {
      bot.deactivateItem()
      this.shieldUp = false
    }
    this.prevAction = a
  }

  selectSlot (slot) {
    this.bot.setQuickBarSlot(slot)
    if (this.charging || this.drawing) {
      // Switching away cancels a crossbow charge or a bow draw, like vanilla: the server's held slot handler stops
      // the use. Letting go of use first (deactivateItem) made the server shoot a drawn bow without the bot
      // counting it (BUG-019). A crossbow charged to full is already loaded by then, in tick()
      this.bot.usingHeldItem = false
      this.charging = false
      this.drawing = false
    }
    // Switching items restarts the swing charge, same as vanilla
    this.ticksSinceSwing = 0
  }

  // A charge long enough to load: take the load once the server's crossbow shows it (BUG-031)
  confirmLoad () {
    if (this.loaded || this.awaitLoad <= 0) return
    const srv = this.serverRanged()
    if (!srv.loaded) return
    this.loaded = true
    this.arrows = srv.arrows
    this.events.loads++
    this.awaitLoad = 0
  }

  // Shot bookkeeping (BUG-018): distance and own movement at the shot, matched with its arrow entity when the
  // spawn packet arrives, resolved by that arrow's hit or by the miss timer
  recordShot (bow) {
    const me = this.bot.entity
    const e = this.enemy.entity()
    const dist = e ? Math.hypot(e.position.x - me.position.x, e.position.z - me.position.z) : 0
    const speed = Math.hypot(me.velocity.x, me.velocity.z)
    const move = !me.onGround ? 'airborne' : speed < MOVE_STILL_SPEED ? 'still' : speed < MOVE_WALK_SPEED ? 'walking' : 'sprinting'
    this.shots.push({ dist: Math.round(dist * 100) / 100, move, timer: SHOT_MISS_TICKS, id: null, weapon: bow ? `bow ${this.bowTicks} ticks` : 'crossbow', bowTicks: bow ? this.bowTicks : 0 })
    // The aim when the arrow leaves, for the aimed shot reward (BUG-020, the view after the step is 2 ticks late):
    // sideways in target widths and vertically in degrees, against where the arrow would meet the target. A bow's
    // power comes from the draw that just ended
    const b = this.aimPoint(bow, bow)
    if (!b) return
    const r = x => Math.round(x * 1000) / 1000
    // their shield raised toward us when the arrow leaves (sim/combat.py: a shot that will be blocked is not aimed)
    const v = this.view({ x: 0, z: 0 })
    // a pillar between our eye and their chest stops it too (sim/combat.py)
    const shielded = (this.enemy.shieldActive() && Math.abs(v.enemyFacingAngle) <= 0.5) || !v.clearShot ? 1 : 0
    this.events.shotAim = [r(b.aimWidths), r(Math.abs(b.leadPitchErr) * 180 / Math.PI), r(b.aimHeights), shielded]
  }

  // Arrow entities near the bot that lie on the ground, and whether their resting spot is known yet
  watchArrows () {
    const me = this.bot.entity.position
    const seen = new Map()
    for (const e of Object.values(this.bot.entities)) {
      if (e.name !== 'arrow' || Math.abs(e.position.x - me.x) > 8 || Math.abs(e.position.z - me.z) > 8) continue
      if (e.metadata?.[ARROW_IN_GROUND] !== true) continue
      const old = this.groundArrows.get(e.id)
      const since = old ? old.since + 1 : 0
      const known = !!old && (old.known || !old.pos.equals(e.position) || since >= ARROW_SPOT_TICKS)
      seen.set(e.id, { pos: e.position.clone(), since, known })
    }
    this.groundArrows = seen
  }

  // The nearest arrow lying within ARROW_SEE_BLOCKS that the bot could reach, forward and right of its look
  nearArrow (local) {
    const me = this.bot.entity.position
    let best = null
    let bestD = Infinity
    for (const a of this.groundArrows.values()) {
      const d = { x: a.pos.x - me.x, y: a.pos.y - me.y, z: a.pos.z - me.z }
      const h = Math.hypot(d.x, d.z)
      if (!a.known || h > ARROW_SEE_BLOCKS || d.y < -PICKUP_BELOW || d.y > PLAYER_H + PICKUP_ABOVE || h >= bestD) continue
      best = d
      bestD = h
    }
    if (!best) return { arrowNear: false, arrowFwd: 0, arrowRight: 0 }
    const [fwd, right] = local(best)
    return { arrowNear: true, arrowFwd: fwd, arrowRight: right }
  }

  // The enemy drawing or loading, holding a loaded crossbow, within melee reach, or an arrow of theirs in flight
  threat (view) {
    const e = this.enemy
    if (e.rangedUse() || e.crossbowLoaded() || (view.visible && view.dist < THREAT_REACH)) return true
    const enemy = e.entity()
    if (!enemy) return false
    return Object.values(this.bot.entities).some(a => a.name === 'arrow' && a.metadata?.[ARROW_IN_GROUND] !== true &&
      this.enemyArrows.has(a.id))
  }

  // Where an arrow fired now would meet the target, and the turn to it (ballistics), or null with no target in sight
  aimPoint (bow, drawing) {
    const me = this.bot.entity
    const e = this.enemy.entity()
    if (!e) return null
    const eye = me.position.offset(0, EYE, 0)
    const d = { x: e.position.x - eye.x, y: e.position.y + 1.2 - eye.y, z: e.position.z - eye.z }
    const lead = this.enemy.leadInputs()
    return ballistics(d, lead.vel, me.velocity, me.yaw, me.pitch, bow, drawing, this.bowTicks, me.onGround,
      e.position.y, this.enemy.onGround(), lead.extra)
  }

  resolveShot (i, hit) {
    const s = this.shots[i]
    this.events.shotResults.push([s.dist, s.move, hit])
    this.shots.splice(i, 1)
  }

  // At the end of a round: an arrow that already stopped (in the ground, or gone without hitting) missed, one still
  // flying is left out of the hit rates, the same as the simulator
  endRoundShots () {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      const arrow = s.id === null ? null : this.bot.entities[s.id]
      if (s.id !== null && (!arrow || arrow.metadata?.[ARROW_IN_GROUND] === true)) {
        this.events.arrowMisses++
        this.resolveShot(i, 0)
      }
    }
    this.shots = []
  }

  // The crossbow's loaded state and the arrow count as the server has them (BUG-019): a crossbow item carries its
  // loaded arrow in the charged_projectiles component, the arrows sit in the inventory
  serverRanged () {
    const inv = this.bot.inventory
    const arrows = inv.items().filter(i => i.name === 'arrow').reduce((n, i) => n + i.count, 0)
    const cb = inv.slots[inv.hotbarStart + SLOT_CROSSBOW]
    const charged = (cb?.components ?? []).find(c => c.type === 'charged_projectiles')
    const loaded = (charged?.data?.projectiles ?? charged?.data ?? []).length > 0
    return { arrows, loaded }
  }

  // Local state predicts the server's, so the bot sees a load or a shot the same tick, as in the simulator. If the
  // two still disagree after DESYNC_TICKS, the server wins and the desync is counted
  syncWithServer () {
    if (this.charging || this.drawing) { this.desyncTicks = 0; return }
    const srv = this.serverRanged()
    if (srv.arrows === this.arrows && srv.loaded === this.loaded) { this.desyncTicks = 0; return }
    if (++this.desyncTicks < DESYNC_TICKS) return
    this.events.desyncs++
    this.events.desyncNote = `arrows ${this.arrows} to ${srv.arrows}, loaded ${this.loaded} to ${srv.loaded}`
    this.arrows = srv.arrows
    this.loaded = srv.loaded
    this.desyncTicks = 0
  }

  // Right click with the crossbow: hold to charge, let go after 1.25 s to load, press again to fire.
  // The main hand item takes priority over the offhand shield, same as vanilla.
  useCrossbow (pressed) {
    const bot = this.bot
    if (this.shieldUp) {
      bot.deactivateItem()
      this.shieldUp = false
    }
    if (pressed && !this.useHeld) {
      this.confirmLoad()  // a load the server finished a moment ago, so this press fires it
      if (this.loaded) {
        bot.activateItem()
        this.loaded = false
        this.events.shots++
        this.recordShot(false)
      } else if (this.arrows > 0) {
        bot.activateItem()
        this.charging = true
        this.crossbowTicks = 0
      }
    } else if (!pressed && this.charging) {
      // Letting go only stops the charge, the load happens in tick() once it is full
      bot.deactivateItem()
      this.charging = false
    }
    this.useHeld = pressed
  }

  // Right click with the bow: hold to draw, let go to shoot. Power grows with the draw, full at 1 s.
  useBow (pressed) {
    const bot = this.bot
    if (this.shieldUp) {
      bot.deactivateItem()
      this.shieldUp = false
    }
    if (pressed && !this.drawing && this.arrows > 0) {
      bot.activateItem()
      this.drawing = true
      this.bowTicks = 0
    } else if (!pressed && this.drawing && this.bowTicks < BOW_MIN_TICKS) {
      // A short draw: letting go might shoot or not depending on packet timing (BUG-029), so cancel it by switching
      // away and back, which stops the use without shooting (BUG-019)
      bot.setQuickBarSlot(bot.quickBarSlot === SLOT_AXE ? SLOT_SWORD : SLOT_AXE)
      bot.setQuickBarSlot(SLOT_BOW)
      bot.usingHeldItem = false
      this.drawing = false
    } else if (!pressed && this.drawing) {
      // The server shoots a bow along the last rotation it received, and Mineflayer only sends this step's turn on
      // its next tick, after the release (BUG-026). So the turn goes out first, as the simulator assumes
      bot._client.write('look', {
        yaw: toNotchianYaw(bot.entity.yaw),
        pitch: toNotchianPitch(bot.entity.pitch),
        onGround: bot.entity.onGround,
        flags: { onGround: bot.entity.onGround, hasHorizontalCollision: undefined }
      })
      bot.deactivateItem()
      this.drawing = false
      this.arrows--
      this.events.shots++
      this.events.shotsBow++
      if (this.bowTicks >= BOW_FULL_TICKS) this.events.fullDraws++  // safe_load counts only full draws
      this.recordShot(true)
    }
  }

  swing () {
    const bot = this.bot
    const e = this.enemy.entity()
    this.events.swings++
    if (e && this.crosshairOnEnemy()) {
      const sprinting = bot.getControlState('sprint')
      const sprintHit = sprinting && this.charge() > 0.9
      // A crit needs a full charge, falling, and no sprint
      // The server needs some real fall distance, so the first tick of falling does not count yet
      const crit = this.charge() > 0.9 && this.ticksFalling >= 2 && !sprinting
      if (crit) this.events.crits++
      // Behind their shield's front half
      if (Math.abs(this.view({ x: 0, z: 0 }).enemyFacingAngle) > 0.5) this.events.backHits++
      // An auto hit is the first hit right after the enemy's axe disabled our shield
      if (this.ticksSinceShieldDisabled <= 4) {
        this.events.autoHits++
        if (crit) this.events.autoCrits++
      }
      const full = this.charge() > 0.9
      // fair health: the damage we believe this swing does, settled by a damage event, a block sound, or the window
      if (this.fairHealth) this.pendingMelee = { amount: meleeDamage(this.weapon(), this.charge(), crit), ticks: 6 }
      bot.attack(e)
      this.events.hits++
      if (full) this.events.fullHits++  // the hit rewards pay only these (BUG-032)
      // Which weapon lands the hits shows whether it learned when to switch from axe to sword
      if (weaponOf(bot.heldItem) === 'sword') {
        this.events.swordHits++
        if (full) this.events.fullSwordHits++
      }
      this.ticksSinceMeleeHit = 0
      // A vanilla client drops sprint after a sprint hit, so keeping sprint needs a reset
      if (sprintHit) bot.setControlState('sprint', false)
    } else {
      bot.swingArm()
    }
    this.ticksSinceSwing = 0
  }

  takeEvents () {
    const ev = this.events
    this.events = freshEvents()
    return ev
  }

  stopEverything () {
    this.bot.clearControlStates()
    // A bow draw is cancelled by switching to the axe, letting go would shoot it (BUG-019)
    if (this.charging || this.drawing) this.selectSlot(SLOT_AXE)
    if (this.shieldUp) this.bot.deactivateItem()
    this.shieldUp = false
    this.secondClick = false
  }

  reset (stop = true) {
    if (stop) this.stopEverything()
    this.shieldUp = false
    this.secondClick = false
    this.ticksSinceSwing = 100
    this.shieldTicks = 0
    this.shieldCooldown = SHIELD_CARRY ? Math.max(this.shieldCooldown || 0, 0) : 0
    this.shieldResyncs = 0
    this.ticksSinceIHit = 100
    this.ticksSinceHitMe = 100
    this.ticksSinceShieldDisabled = 100
    this.ticksSinceEnemyWhiff = 100
    this.ticksSinceMyBlock = 100
    this.whiffCheck = 0
    this.ticksFalling = 0
    this.charging = false
    this.crossbowTicks = 0
    this.drawing = false
    this.bowTicks = 0
    this.loaded = false
    this.arrows = ARROWS
    this.useHeld = false
    this.shots = []
    this.desyncTicks = 0
    this.awaitLoad = 0
    this.groundArrows = new Map()
    this.enemyArrows = new Set()
    this.ticksSinceMeleeHit = 100
    this.combo = 0
    this.hitSinceMyHit = true
    this.prevAction = IDLE_ACTION
    this.events = freshEvents()
    this.hpEst.reset()
    this.pendingMelee = null
    this.enemyEating = 0
    if (stop) this.enemy.reset()
  }

  // Raw numbers about the fight, used by the observation and by the scripted opponent.
  view (center) {
    const me = this.bot.entity
    const e = this.enemy.entity()
    const f = { x: -Math.sin(me.yaw), z: -Math.cos(me.yaw) }
    const r = { x: Math.cos(me.yaw), z: -Math.sin(me.yaw) }
    const local = v => [v.x * f.x + v.z * f.z, v.x * r.x + v.z * r.z]
    const half = 15  // bridge.js HALF

    const v = {
      visible: !!e,
      yawErr: 0,
      leadYawErr: 0,
      leadPitchErr: 0,
      aimWidths: 5,
      flightTicks: 0,
      enemyStill: false,
      clearShot: false,
      covered: false,
      pitchErr: 0,
      dist: 8,
      reachDist: 8,
      dy: 0,
      crosshair: false,
      myVel: local(me.velocity),
      myVelY: me.velocity.y,
      enemyVel: [0, 0],
      enemyVelY: 0,
      onGround: me.onGround,
      enemyOnGround: true,
      hp: this.bot.health,
      // fair health (DEC-076): our own estimate, never their health metadata
      enemyHp: this.fairHealth ? this.hpEst.value() : this.enemy.health() ?? 20,
      charge: this.charge(),
      enemyCharge: this.enemy.chargeEstimate(),
      weapon: this.weapon(),
      shieldUp: this.shieldUp,
      shieldActive: this.shieldUp && this.shieldTicks >= SHIELD_DELAY_TICKS,
      shieldCooldown: this.shieldCooldown,
      enemyShieldUp: this.enemy.shieldUp(),
      enemyRangedUse: this.enemy.rangedUse(),
      enemyLoaded: this.enemy.crossbowLoaded(),
      enemyShieldActive: this.enemy.shieldActive(),
      enemyShieldCooldown: this.enemy.shieldCooldown,
      enemyFacing: 0,
      enemyFacingAngle: 1,
      enemySprinting: this.enemy.sprinting(),
      enemyWeapon: 'none',
      sinceIHit: this.ticksSinceIHit,
      sinceHitMe: this.ticksSinceHitMe,
      sinceShieldDisabled: this.ticksSinceShieldDisabled,
      enemySinceSwing: this.enemy.ticksSinceSwing,
      sinceEnemyWhiff: this.ticksSinceEnemyWhiff,
      combo: this.combo,
      pos: local({ x: me.position.x - center.x, z: me.position.z - center.z }),
      wallDist: half - Math.max(Math.abs(me.position.x - center.x), Math.abs(me.position.z - center.z)),
      sprinting: this.bot.getControlState('sprint'),
      crossbowLoaded: this.loaded,
      crossbowCharge: this.charging ? Math.min(this.crossbowTicks / CROSSBOW_CHARGE_TICKS, 1) : 0,
      bowDraw: this.drawing ? Math.min(this.bowTicks / BOW_FULL_TICKS, 1) : 0,
      arrows: this.arrows,
      sinceMeleeHit: this.ticksSinceMeleeHit,
      longShot: false
    }
    v.terrain = this.terrain()
    Object.assign(v, this.nearArrow(local))
    if (!e) return v

    const eye = me.position.offset(0, EYE, 0)
    const d = { x: e.position.x - eye.x, y: e.position.y + 1.2 - eye.y, z: e.position.z - eye.z }
    const horiz = Math.hypot(d.x, d.z)
    v.yawErr = wrap(Math.atan2(-d.x, -d.z) - me.yaw)
    v.pitchErr = Math.atan2(d.y, horiz) - me.pitch
    v.dist = horiz
    v.reachDist = pointBoxDistance(eye, e.position)
    v.dy = e.position.y - me.position.y
    v.crosshair = this.crosshairOnEnemy()
    v.longShot = this.crosshairOnEnemy(30)
    v.enemyVel = local(this.enemy.vel)
    v.enemyVelY = this.enemy.vel.y
    const lead = this.enemy.leadInputs()
    Object.assign(v, ballistics(d, lead.vel, me.velocity, me.yaw, me.pitch, v.weapon === 'bow', this.drawing,
      this.bowTicks, me.onGround, e.position.y, this.enemy.onGround(), lead.extra))
    v.enemyStill = Math.hypot(this.enemy.vel.x, this.enemy.vel.z) < 0.02
    // nothing between the eye and their chest (sim/observe.py clearShot)
    const len = Math.hypot(d.x, d.y, d.z)
    v.clearShot = len < 0.01 || !this.bot.world.raycast(eye, new Vec3(d.x / len, d.y / len, d.z / len), len)
    // a pillar between our eyes and theirs, the wall shooter's cover (letter W, sim/observe.py covered). Reward only
    const c = { x: e.position.x - eye.x, y: e.position.y + EYE - eye.y, z: e.position.z - eye.z }
    const clen = Math.hypot(c.x, c.y, c.z)
    v.covered = clen >= 0.01 && !!this.bot.world.raycast(eye, new Vec3(c.x / clen, c.y / clen, c.z / clen), clen)
    v.enemyOnGround = this.enemy.onGround()
    v.enemyWeapon = weaponOf(e.heldItem)
    const toMe = { x: me.position.x - e.position.x, z: me.position.z - e.position.z }
    const n = Math.hypot(toMe.x, toMe.z) || 1
    v.enemyFacing = (-Math.sin(e.yaw) * toMe.x + -Math.cos(e.yaw) * toMe.z) / n
    // Signed angle between where they look and where we are: under 90 degrees means we are in
    // front of their shield, over 90 means a hit lands on their back
    v.enemyFacingAngle = wrap(Math.atan2(-toMe.x, -toMe.z) - e.yaw) / Math.PI
    return v
  }

  observe (center, roundTime = 0, strategy = [0, 0, 0, 0]) {
    const v = this.view(center)
    const p = this.prevAction
    const obs = [
      v.yawErr / Math.PI,
      clamp(v.pitchErr / (Math.PI / 2), -1, 1),
      clamp(v.dist / 8, 0, 2),
      clamp(v.reachDist / 4, 0, 2),
      clamp(v.dy / 3, -2, 2),
      v.crosshair ? 1 : 0,
      clamp(v.myVel[0] * 3, -3, 3),
      clamp(v.myVel[1] * 3, -3, 3),
      clamp(v.myVelY * 3, -3, 3),
      clamp(v.enemyVel[0] * 3, -3, 3),
      clamp(v.enemyVel[1] * 3, -3, 3),
      clamp(v.enemyVelY * 3, -3, 3),
      v.onGround ? 1 : 0,
      v.enemyOnGround ? 1 : 0,
      v.hp / 20,
      v.enemyHp / 20,
      v.charge,
      v.enemyCharge,
      v.weapon === 'axe' ? 1 : 0,
      v.weapon === 'sword' ? 1 : 0,
      v.enemyWeapon === 'axe' ? 1 : 0,
      v.enemyWeapon === 'sword' ? 1 : 0,
      v.shieldUp ? 1 : 0,
      v.shieldActive ? 1 : 0,
      v.shieldCooldown / SHIELD_DISABLE_TICKS,
      v.enemyShieldUp ? 1 : 0,
      v.enemyShieldActive ? 1 : 0,
      v.enemyShieldCooldown / SHIELD_DISABLE_TICKS,
      v.enemyFacing,
      v.enemyFacingAngle,
      v.enemySprinting ? 1 : 0,
      Math.min(v.sinceIHit, 40) / 40,
      Math.min(v.sinceHitMe, 40) / 40,
      Math.min(v.sinceShieldDisabled, 40) / 40,
      Math.min(v.enemySinceSwing, 40) / 40,
      Math.min(v.sinceEnemyWhiff, 40) / 40,
      Math.min(v.combo, 5) / 5,
      clamp(v.pos[0] / 12, -1.5, 1.5),
      clamp(v.pos[1] / 12, -1.5, 1.5),
      clamp(v.wallDist / 12, 0, 1),
      v.sprinting ? 1 : 0,
      roundTime,
      [0, 1, -1][p[0]],
      [0, -1, 1][p[1]],
      p[2],
      p[3],
      YAW_STEPS[p[4]] / 90,
      p[6] / 2,
      p[7],
      ...v.terrain.grid,
      Math.min(v.terrain.lavaDist, 5) / 5,
      Math.sin(v.terrain.lavaDir),
      Math.cos(v.terrain.lavaDir),
      v.weapon === 'crossbow' ? 1 : 0,
      v.crossbowLoaded ? 1 : 0,
      v.crossbowCharge,
      Math.min(v.arrows, ARROWS) / ARROWS,  // pickups can take it over 6, the simulator caps it too
      v.enemyWeapon === 'crossbow' ? 1 : 0,
      v.weapon === 'bow' ? 1 : 0,
      v.bowDraw,
      v.enemyWeapon === 'bow' ? 1 : 0,
      v.enemyRangedUse ? 1 : 0,
      Math.min(v.dist / 32, 1.5),
      clamp(v.leadYawErr / (Math.PI / 6), -2, 2),
      clamp(v.leadPitchErr / (Math.PI / 6), -2, 2),
      Math.min(v.aimWidths, 5) / 5,
      Math.min(v.flightTicks / 20, 2),
      v.enemyStill ? 1 : 0,
      v.clearShot ? 1 : 0,
      v.arrowNear ? 1 : 0,
      v.arrowFwd / ARROW_SEE_BLOCKS,
      v.arrowRight / ARROW_SEE_BLOCKS,
      v.enemyLoaded ? 1 : 0,
      // the enemy kind input (FIND-023, sim/observe.py KIND_INPUTS), only for a version trained with it: 1 for a mob
      ...(this.kindInput ? [this.enemyIsMob() ? 1 : 0] : []),
      // the block grid (idea 40, sim/blockgrid.py), only for a version trained with it, after the kind input
      ...(this.blockGridInput ? this.blockGrid() : []),
      ...strategy
    ]
    const want = OBS_DIM + (this.kindInput ? 1 : 0) + (this.blockGridInput ? GRID_INPUTS : 0)
    if (obs.length !== want) throw new Error(`observation has ${obs.length} values, expected ${want}`)
    return obs.map(x => (Number.isFinite(x) ? x : 0))
  }
}

module.exports = { Fighter, ACTION_DIMS, OBS_DIM, GRID_INPUTS, blockGrid, IDLE_ACTION, YAW_STEPS, PITCH_STEPS, SLOT_AXE, SLOT_SWORD, SLOT_CROSSBOW, SLOT_BOW }
