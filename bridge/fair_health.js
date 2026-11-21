// Fair health (DEC-076, Ezekiel): real Minecraft shows no hearts above other players, so with the fair_health
// option the enemyHp input is the fighter's own estimate of the enemy's health, kept the way a good player keeps it in
// his head. It never reads the enemy's health metadata. The same rules as pvpbot/sim/combat.py estimate_hit:
//
// It starts at the enemy's full health, known from its kind (20 for every player, the zombie tests from their kind).
// Each of our hits that lands takes off the damage we believe it did: our weapon, charge and crit for melee, the
// average crit bonus for an arrow, after the enemy's visible armor and the protection its kind is known to wear. A hit
// inside the enemy's hurt window (10 ticks after a full hit) only counts by how much it beats the last one, and a
// shield block counts 0. Healing we could see is added back: a golden apple seen eaten (Regeneration II for 5 s, 4
// health, and 4 absorption), an enchanted one (Regeneration II for 20 s, 16 absorption, Resistance I), and natural
// regeneration only when the server has it on (1 health every 4 s, the rule for a full food bar without saturation).
// Our arenas turn natural regeneration off (bridge.js GAMERULES) and give no food, the same as the simulator.

const ENEMY_KINDS = {
  // full unenchanted diamond, our KIT and HUMAN_KIT
  player: { armor: 20, toughness: 8, protection: 0, health: 20 },
  // pvpbot/sim/constants.py ZOMBIES and RANGED_MOBS, which match bridge.js ZOMBIE_NBT
  minus: { armor: 0, toughness: 0, protection: 0, health: 10 },
  basic: { armor: 3, toughness: 0, protection: 0, health: 20 },
  plus: { armor: 22, toughness: 8, protection: 0, health: 20 },
  ultimate: { armor: 22, toughness: 8, protection: 12, health: 21.6 },
  apex: { armor: 22, toughness: 8, protection: 12, health: 17 },
  gad: { armor: 22, toughness: 8, protection: 12, health: 17 },
  skeleton: { armor: 0, toughness: 0, protection: 0, health: 20 },
  skeleton_power: { armor: 0, toughness: 0, protection: 0, health: 20 },
  pillager: { armor: 0, toughness: 0, protection: 0, health: 24 }
}

// What a player assumes once he sees an apple eaten (vanilla 1.21 Foods and Consumables)
const APPLES = {
  golden_apple: { regenTicks: 100, regenEvery: 25, absorption: 4, resistTicks: 0 },
  enchanted_golden_apple: { regenTicks: 400, regenEvery: 25, absorption: 16, resistTicks: 6000 }
}
const EAT_TICKS = 32  // every food takes 32 ticks of use (dried kelp 16, never in a fight)
const NATURAL_REGEN_TICKS = 80

const MELEE_DAMAGE = { axe: 9, sword: 7 }  // diamond, anything else is a fist (1)

// CombatRules.getDamageAfterAbsorb, the same as pvpbot/sim/combat.py armor()
function afterArmor (dmg, points, toughness) {
  const f = Math.max(points * 0.2, Math.min(20, points - dmg / (2 + toughness / 4)))
  return dmg * (1 - f / 25)
}

// Melee damage before armor from our own swing (sim/combat.py attack_damage)
function meleeDamage (weapon, charge, crit) {
  const dmg = (MELEE_DAMAGE[weapon] ?? 1) * (0.2 + charge * charge * 0.8)
  return crit && charge > 0.9 ? dmg * 1.5 : dmg
}

// An arrow's damage before armor as its shooter can judge it: ceil(speed times 2), speed 0.99 less each tick of
// flight, plus the average crit bonus (crossbow arrows always, bow arrows at full draw)
function arrowDamage (launchSpeed, flightTicks, crit) {
  const base = Math.ceil(launchSpeed * Math.pow(0.99, Math.max(flightTicks, 0)) * 2)
  return base + (crit ? (Math.floor(base / 2) + 1) / 2 : 0)
}

class HealthEstimate {
  constructor (kind = 'player', naturalRegen = false) {
    this.naturalRegen = naturalRegen
    this.reset(kind)
  }

  reset (kind = this.kind) {
    this.kind = ENEMY_KINDS[kind] ? kind : 'player'
    const k = ENEMY_KINDS[this.kind]
    this.max = k.health
    this.hp = k.health
    this.absorption = 0
    this.last = 0  // our last hit that took, before armor
    this.window = 0  // our count of their hurt window, 20 at a full hit
    this.regenLeft = 0
    this.regenEvery = 25
    this.resistLeft = 0
    this.sinceRegen = 0
  }

  value () {
    return this.hp + this.absorption
  }

  inside () {
    return this.window > 10
  }

  // One of our hits reached them. known: the damage before armor we believe it did. full: true when we saw the damage
  // event or the block sound (a full hit), false for a hit inside the window, null to judge from our own count
  hit (known, blocked = false, full = null) {
    const k = ENEMY_KINDS[this.kind]
    const amount = blocked ? 0 : known
    const partial = full === null ? this.inside() : !full
    if (partial && amount <= this.last) return 0
    const raw = partial ? amount - this.last : amount
    this.last = amount
    if (!partial) this.window = 20
    if (raw <= 0) return 0
    let loss = afterArmor(raw, k.armor, k.toughness) * (1 - k.protection / 25)
    if (this.resistLeft > 0) loss *= 0.8
    const fromAbsorption = Math.min(this.absorption, loss)
    this.absorption -= fromAbsorption
    this.hp = Math.max(this.hp - (loss - fromAbsorption), 0)
    return loss
  }

  // They finished eating item (its name)
  ate (item) {
    const a = APPLES[item]
    if (!a) return
    this.regenLeft = Math.max(this.regenLeft, a.regenTicks)
    this.regenEvery = a.regenEvery
    this.absorption = Math.max(this.absorption, a.absorption)
    this.resistLeft = Math.max(this.resistLeft, a.resistTicks)
  }

  tick () {
    if (this.window > 0) this.window--
    if (this.resistLeft > 0) this.resistLeft--
    if (this.regenLeft > 0) {
      this.regenLeft--
      if (this.regenLeft % this.regenEvery === 0) this.hp = Math.min(this.hp + 1, this.max)
    }
    if (this.naturalRegen && ++this.sinceRegen >= NATURAL_REGEN_TICKS) {
      this.sinceRegen = 0
      this.hp = Math.min(this.hp + 1, this.max)
    }
  }
}

module.exports = { HealthEstimate, ENEMY_KINDS, APPLES, EAT_TICKS, afterArmor, meleeDamage, arrowDamage }
