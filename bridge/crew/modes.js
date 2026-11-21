// A priority ordered mode manager, after the mindcraft project's ModeController (src/agent/modes.js).
//
// Every tick the manager first checks for a stop request. A stop always wins: it turns every job mode off, calls
// stopAll (which clears goals and keys) and settles every waiting job. Otherwise the highest mode that is on and
// wants control right now gets it. A mode that loses control is told to exit (a fight pauses a mining job), and
// gets control back later when nothing above it wants it.
//
// Each mode belongs to a skill profile: fight (the trained network), mine, survive (eating, food, retreat), move,
// and later build. When control passes to a mode of another profile the manager calls hooks.profileChanged, so the
// crew can put one profile's tools and keys away before the next one starts.
//
// No Minecraft in here, so test/modes.test.js drives it with fake modes.

class Mode {
  constructor (name) {
    this.name = name
    this.on = false
    this.params = {}
    this.pending = null  // the promise of the job started by the last start()
    this.settle = null
    this.profile = 'idle'
  }

  // Turns the mode on with these settings and returns a promise for when its job ends ('done', 'stopped', 'off',
  // or a reason). Modes that never end on their own (guard, follow) settle when they are turned off
  start (params = {}) {
    this.finish('replaced')
    this.on = true
    this.params = params
    this.pending = new Promise(resolve => { this.settle = resolve })
    this.onStart?.()
    return this.pending
  }

  // Ends the job and turns the mode off
  finish (result = 'done') {
    const settle = this.settle
    this.settle = null
    this.on = false
    if (settle) settle(result)
  }

  wants () { return true }
  enter () {}
  update () {}
  exit () {}
  describe () { return this.name }
}

class ModeManager {
  // modes: highest priority first. hooks.stopAll() clears goals, controls, digging and fights
  constructor (modes, hooks = {}) {
    this.modes = modes
    this.byName = new Map(modes.map(m => [m.name, m]))
    this.hooks = hooks
    this.active = null
    this.profile = 'idle'
    this.stopRequested = false
  }

  // Tells the crew when control moves to a mode of another skill profile
  switchProfile (next) {
    if (next === this.profile) return
    const prev = this.profile
    this.profile = next
    try { this.hooks.profileChanged?.(prev, next) } catch (err) { this.hooks.log?.(`profile ${prev} to ${next}: ${err.message}`) }
  }

  get (name) {
    const m = this.byName.get(name)
    if (!m) throw new Error(`no mode ${name}`)
    return m
  }

  setOn (name, params) {
    const m = this.get(name)
    // a new order for the mode in control restarts it: exit now, the next tick enters it again with the new settings
    if (m === this.active) {
      this.active = null
      try { m.exit() } catch (err) { this.hooks.log?.(`exit ${m.name}: ${err.message}`) }
    }
    return m.start(params)
  }

  setOff (name, result = 'off') {
    const m = this.get(name)
    if (m === this.active) {
      this.active = null
      m.exit()
    }
    m.finish(result)
  }

  requestStop () {
    this.stopRequested = true
  }

  // Ends every job mode now, in the same tick
  stopNow () {
    this.stopRequested = false
    const active = this.active
    this.active = null
    if (active) {
      try { active.exit() } catch (err) { this.hooks.log?.(`exit ${active.name}: ${err.message}`) }
    }
    for (const m of this.modes) if (!m.always) m.finish('stopped')
    this.hooks.stopAll?.()
    this.switchProfile('idle')
  }

  tick () {
    if (this.stopRequested) {
      this.stopNow()
      return
    }
    let chosen = null
    for (const m of this.modes) {
      if (!(m.on || m.always)) continue
      let wants = false
      try { wants = m.wants() } catch (err) { this.hooks.log?.(`${m.name}.wants: ${err.message}`) }
      // a mode can finish itself inside wants() (kill with nobody left), so check again
      if (wants && (m.on || m.always)) {
        chosen = m
        break
      }
    }
    if (chosen !== this.active) {
      const prev = this.active
      this.active = chosen
      if (prev) {
        try { prev.exit() } catch (err) { this.hooks.log?.(`exit ${prev.name}: ${err.message}`) }
      }
      this.switchProfile(chosen ? chosen.profile : 'idle')
      if (chosen) {
        try { chosen.enter() } catch (err) { this.hooks.log?.(`enter ${chosen.name}: ${err.message}`) }
      }
    }
    if (this.active) {
      try { this.active.update() } catch (err) { this.hooks.log?.(`update ${this.active.name}: ${err.message}`) }
    }
  }

  status () {
    return this.active ? this.active.describe() : 'idle'
  }
}

module.exports = { Mode, ModeManager }
