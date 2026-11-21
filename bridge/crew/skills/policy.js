// Talks to crew_policy.py, the Python process that runs the trained fighting network for every crew bot.
// One JSON line per decision each way: {"id", "key", "obs"} out, {"id", "action"} back.

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const readline = require('readline')

const ROOT = path.join(__dirname, '..', '..', '..')
const REPLY_MS = 1000  // a decision slower than this is dropped and the bot idles for that step

class PolicyClient {
  constructor (run, log = () => {}) {
    this.run = run
    this.log = log
    this.nextId = 1
    this.waiting = new Map()
    this.ready = null
    this.info = null
    this.failed = null
  }

  python () {
    // Windows keeps the venv's Python in Scripts (his other PC)
    const win = process.platform === 'win32'
    const venv = win ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python')
    return fs.existsSync(venv) ? venv : (win ? 'python' : 'python3')
  }

  // Starts the Python side on first use. Resolves with {name, rate} once the network is loaded
  start () {
    if (this.ready) return this.ready
    this.failed = null
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.python(), [path.join(ROOT, 'crew_policy.py'), '--run', this.run], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.proc = proc
      const lines = readline.createInterface({ input: proc.stdout })
      lines.on('line', line => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        if (msg.hello) {
          this.info = msg.hello
          this.log(`fighter network ${msg.hello.name} loaded, ${msg.hello.rate} decisions a second`)
          resolve(msg.hello)
          return
        }
        if (msg.error && msg.id == null) {
          this.failed = msg.error
          reject(new Error(msg.error))
          return
        }
        const w = this.waiting.get(msg.id)
        if (!w) return
        this.waiting.delete(msg.id)
        clearTimeout(w.timer)
        if (msg.error) w.resolve(null)
        else w.resolve(msg.action)
      })
      proc.stderr.on('data', d => {
        const text = String(d).trim()
        if (text) this.log(`[policy] ${text.split('\n').slice(-3).join(' | ')}`)
      })
      proc.on('exit', code => {
        this.failed = this.failed || `the fighter network stopped (exit ${code})`
        for (const w of this.waiting.values()) { clearTimeout(w.timer); w.resolve(null) }
        this.waiting.clear()
        this.ready = null
        this.proc = null
        reject(new Error(this.failed))
      })
    })
    this.ready.catch(() => {})
    return this.ready
  }

  // One decision for one bot. Resolves with the action, or null when the network is slow or gone
  async act (key, obs) {
    await this.start()
    if (!this.proc) return null
    const id = this.nextId++
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null) }, REPLY_MS)
      this.waiting.set(id, { resolve, timer })
      this.proc.stdin.write(JSON.stringify({ id, key, obs }) + '\n')
    })
  }

  close () {
    if (!this.proc) return
    try { this.proc.stdin.end() } catch {}
    const proc = this.proc
    setTimeout(() => { if (proc.exitCode === null) proc.kill() }, 3000)
  }
}

module.exports = { PolicyClient }
