// Friend or foe, the shared focus target, and the friendly fire guard.

const PLAYER_HALF_WIDTH = 0.3
const PLAYER_HEIGHT = 1.8
const EYE = 1.62
const FRIEND_PAD = 0.15  // a little wider than a player, so a shoulder in the way also blocks the swing

class Friends {
  constructor (owner, bots, extra = []) {
    this.owner = owner
    this.names = new Set([owner, ...bots, ...extra].map(n => n.toLowerCase()))
  }

  has (name) {
    return !!name && this.names.has(String(name).toLowerCase())
  }

  add (name) { this.names.add(String(name).toLowerCase()) }

  isFriendEntity (e) {
    return !!e && e.type === 'player' && this.has(e.username)
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Monsters by the game's own category (minecraft-data type "hostile": zombies, skeletons, creepers and so on)
function isHostile (e) {
  return !!e && e.type === 'hostile'
}

// Who a crew bot may attack: hostile mobs and players who are not friends. Never friends, never animals
function isEnemy (e, friends) {
  if (!e || e.isValid === false) return false
  if (e.type === 'player') return !!e.username && !friends.has(e.username)
  return isHostile(e)
}

// Enemies around a centre, nearest first. entities is bot.entities (or any id to entity map)
function enemiesNear (entities, center, radius, friends, self = null) {
  const out = []
  for (const e of Object.values(entities)) {
    if (e === self || !isEnemy(e, friends) || !e.position) continue
    const d = dist(e.position, center)
    if (d <= radius) out.push({ e, d })
  }
  out.sort((a, b) => a.d - b.d)
  return out.map(x => x.e)
}

// The kill focus every crew bot shares: the one the owner named, else the current focus while it is still in the
// list, else the enemy nearest the owner (or the given centre)
function pickFocus (enemies, center, named, currentId) {
  if (named) {
    const want = named.toLowerCase()
    return enemies.find(e => (e.username || '').toLowerCase() === want) || null
  }
  if (currentId != null) {
    const cur = enemies.find(e => e.id === currentId)
    if (cur) return cur
  }
  let best = null
  let bestD = Infinity
  for (const e of enemies) {
    const d = dist(e.position, center)
    if (d < bestD) { best = e; bestD = d }
  }
  return best
}

// Shared memory for all crew bots in this process (they run in one Node process): the kill focus and the named
// target. Entity ids come from the server, so every bot agrees on them
class Blackboard {
  constructor () {
    this.focusId = null
    this.named = null
    this.killCenter = null
  }

  clear () {
    this.focusId = null
    this.named = null
  }
}

// Slab test: where a ray first enters a box, or null. t is in blocks along the unit direction
function rayBox (origin, dir, min, max) {
  let lo = -Infinity
  let hi = Infinity
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(dir[k]) < 1e-9) {
      if (origin[k] < min[k] || origin[k] > max[k]) return null
      continue
    }
    let t1 = (min[k] - origin[k]) / dir[k]
    let t2 = (max[k] - origin[k]) / dir[k]
    if (t1 > t2) [t1, t2] = [t2, t1]
    lo = Math.max(lo, t1)
    hi = Math.min(hi, t2)
    if (lo > hi) return null
  }
  if (hi < 0) return null
  return Math.max(lo, 0)
}

// A friend standing between the attacker's eyes and the target's body (or the target itself a friend) blocks the
// swing. Positions are plain {x, y, z}
function friendInTheWay (eyePos, target, others, friends) {
  if (!target) return null
  if (friends.isFriendEntity(target)) return target
  const aim = { x: target.position.x, y: target.position.y + (target.height || PLAYER_HEIGHT) * 0.6, z: target.position.z }
  const d = { x: aim.x - eyePos.x, y: aim.y - eyePos.y, z: aim.z - eyePos.z }
  const len = Math.hypot(d.x, d.y, d.z)
  if (len < 1e-6) return null
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len }
  for (const f of others) {
    if (!f || f === target || !friends.isFriendEntity(f) || !f.position) continue
    const w = PLAYER_HALF_WIDTH + FRIEND_PAD
    const min = { x: f.position.x - w, y: f.position.y, z: f.position.z - w }
    const max = { x: f.position.x + w, y: f.position.y + PLAYER_HEIGHT + FRIEND_PAD, z: f.position.z + w }
    const t = rayBox(eyePos, dir, min, max)
    if (t !== null && t < len) return f
  }
  return null
}

// Wraps bot.attack so no code path (the trained fighter included) can hit a friend: the target itself or anyone
// standing in the line of the swing. A blocked swing only swings the arm
function guardAttacks (bot, friends, log = () => {}) {
  const attack = bot.attack.bind(bot)
  bot.attack = (target, swing = true) => {
    const me = bot.entity.position
    const eye = { x: me.x, y: me.y + EYE, z: me.z }
    const blocker = friendInTheWay(eye, target, Object.values(bot.entities).filter(e => e !== bot.entity), friends)
    if (blocker) {
      bot.blockedHits = (bot.blockedHits || 0) + 1
      if (bot.blockedHits % 20 === 1) log(`${bot.username}: held a swing, ${blocker.username || blocker.name} was in the way`)
      bot.swingArm()
      return
    }
    return attack(target, swing)
  }
}

module.exports = { Friends, Blackboard, isHostile, isEnemy, enemiesNear, pickFocus, rayBox, friendInTheWay, guardAttacks, dist }
