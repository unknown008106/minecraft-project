// Human-like touches for scripted jobs (mining for now): short random pauses, eased looks around, small detours,
// and the torch spacing. Three levels: off, light (the default) and full. Trained smooth mining from his own
// recorded play replaces these knobs in a later phase.

const LEVELS = {
  off: { pause: 0, pauseMs: [0, 0], look: 0, detour: 0, detourBlocks: [0, 0], torchEvery: [10, 14], lookSteps: [1, 1] },
  light: { pause: 0.25, pauseMs: [300, 1500], look: 0.2, detour: 0.25, detourBlocks: [1, 2], torchEvery: [10, 14], lookSteps: [6, 10] },
  full: { pause: 0.5, pauseMs: [1000, 6000], look: 0.4, detour: 0.5, detourBlocks: [2, 3], torchEvery: [8, 12], lookSteps: [8, 14] }
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))
const ease = t => t * t * (3 - 2 * t)  // smoothstep: slow start, slow stop

class Human {
  constructor (bot, level = 'light') {
    this.bot = bot
    this.setLevel(level)
  }

  setLevel (level) {
    this.level = LEVELS[level] ? level : 'light'
    this.k = LEVELS[this.level]
  }

  // Turns the head to (yaw, pitch) over a few ticks with easing, the way a mouse moves. Instant when off
  async lookTo (yaw, pitch, token) {
    const bot = this.bot
    const [lo, hi] = this.k.lookSteps
    const steps = randInt(lo, hi)
    const y0 = bot.entity.yaw
    const p0 = bot.entity.pitch
    const dy = wrap(yaw - y0)
    const dp = pitch - p0
    for (let i = 1; i <= steps; i++) {
      if (token?.cancelled) return
      const t = ease(i / steps)
      // a hair of wobble so the line is never perfectly straight
      const wobble = i < steps ? rand(-0.01, 0.01) : 0
      await bot.look(y0 + dy * t + wobble, p0 + dp * t + wobble, true)
      if (steps > 1) await bot.waitForTicks(1)
    }
  }

  async lookAtPoint (point, token) {
    const eye = this.bot.entity.position.offset(0, this.bot.entity.height ?? 1.62, 0)
    const d = point.minus(eye)
    const yaw = Math.atan2(-d.x, -d.z)
    const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    await this.lookTo(yaw, pitch, token)
  }

  // Maybe a short stop, maybe a look around, now and then
  async idleMoment (token) {
    if (Math.random() < this.k.pause) {
      const [lo, hi] = this.k.pauseMs
      await sleep(rand(lo, hi))
    }
    if (token?.cancelled) return
    if (Math.random() < this.k.look) await this.lookAround(token)
  }

  async lookAround (token) {
    const bot = this.bot
    const yaw = bot.entity.yaw + rand(0.5, 1.7) * (Math.random() < 0.5 ? -1 : 1)
    const pitch = rand(-0.35, 0.35)
    await this.lookTo(yaw, pitch, token)
    if (token?.cancelled) return
    await sleep(rand(150, 600))
  }

  // A small sideways waypoint on the way to a spot, or null when it walks straight there
  detourPoint (from, to) {
    if (Math.random() >= this.k.detour) return null
    const dx = to.x - from.x
    const dz = to.z - from.z
    const len = Math.hypot(dx, dz)
    if (len < 4) return null
    const side = (Math.random() < 0.5 ? -1 : 1) * rand(this.k.detourBlocks[0], this.k.detourBlocks[1])
    const along = rand(0.3, 0.6)
    return {
      x: from.x + dx * along + (-dz / len) * side,
      y: from.y + (to.y - from.y) * along,
      z: from.z + dz * along + (dx / len) * side
    }
  }

  nextTorchGap () {
    const [lo, hi] = this.k.torchEvery
    return randInt(lo, hi)
  }

  get placesTorches () { return this.level !== 'off' }
}

module.exports = { Human, LEVELS, sleep }
