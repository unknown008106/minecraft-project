// Turns the owner's plain words ("@crew go get me some diamonds and then come back") into crew commands through
// the Claude API, then checks every command with the same parser as typed ones. Anything that does not parse is
// dropped. No Anthropic SDK is installed in bridge/node_modules or the Python environment, so this is plain HTTPS.
//
// The key and the workspace ID come from ~/.config/anthropic/api.env. The key is never printed or logged.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { COMMANDS, parseMessage } = require('./commands')

const ENV_FILE = path.join(os.homedir(), '.config', 'anthropic', 'api.env')
const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2026-10-21'
const TIMEOUT_MS = 20000

function loadCredentials (file = ENV_FILE) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  let key = null
  let workspace = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const k = line.match(/^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)/)
    if (k) key = k[1]
    const w = line.match(/(wrkspc_[A-Za-z0-9_-]+)/)
    if (w && !k) workspace = w[1]
  }
  return key && workspace ? { key, workspace } : null
}

function systemPrompt (botNames, blueprints = []) {
  return [
    'You turn a Minecraft player\'s request to his helper bots into bot commands.',
    `Bots: ${botNames.join(', ')}. Without a bot name every bot does the command, "!Crew1 mine iron 10" addresses one bot. Build, farm, expand, explore and design go to one bot by themselves.`,
    'Allowed commands, exactly this syntax:',
    ...Object.values(COMMANDS),
    'A bot runs its commands in order, waiting for each job to end (mine, come, give, kill, build, expand, explore and design end on their own, guard, follow and farm do not, so put them last).',
    ...(blueprints.length ? [
      'Blueprints the crew can build, use these names with !build and !expand:',
      ...blueprints.map(b => `  ${b.name}: ${b.description || ''}`),
      '"here" means where the player stands. A house, hut or shelter is small_hut, a farm or wheat field is !farm wheat here (it builds the village wheat farm and keeps it going), a bigger farm or longer wall is !expand.',
      'Only for a structure this list does not have: "!design <new_name> <his description in a few words>" and then "!build <new_name> here". Never !design something the list has.'
    ] : []),
    'Reply with JSON only, for example {"commands": ["!mine diamond 5", "!come"]} or {"commands": ["!build small_hut here"]}.',
    'If the request needs anything these commands cannot do, reply {"commands": [], "reject": "short reason"}.'
  ].join('\n')
}

class Translator {
  constructor ({ model, botNames, log = () => {}, credentials, blueprints = () => [] } = {}) {
    this.model = model || 'claude-haiku-5-5'
    this.botNames = botNames
    this.log = log
    this.blueprints = blueprints
    this.creds = credentials === undefined ? loadCredentials() : credentials
  }

  get enabled () { return !!this.creds }

  // Returns { lines: ['!mine diamond 5', ...], parsed: [{targets, command}], reject?, error? }
  async translate (text, targets = 'all') {
    if (!this.enabled) return { lines: [], parsed: [], error: 'the translator is off (no API key in ~/.config/anthropic/api.env)' }
    const who = targets === 'all' ? 'the whole crew' : targets.join(', ')
    const body = {
      model: this.model,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system: systemPrompt(this.botNames, this.blueprints()),
      messages: [{ role: 'user', content: `Request to ${who}: ${text}` }]
    }
    let reply
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.creds.key,
          'anthropic-version': API_VERSION,
          'anthropic-workspace-id': this.creds.workspace
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      reply = await res.json()
      if (!res.ok) return { lines: [], parsed: [], error: `API error ${res.status}: ${reply?.error?.message || 'unknown'}` }
    } catch (err) {
      return { lines: [], parsed: [], error: `API request failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}` }
    }
    if (reply.stop_reason === 'refusal') return { lines: [], parsed: [], reject: 'refused' }
    const out = (reply.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    return this.check(out, targets)
  }

  // Parses the model's JSON and keeps only commands the normal parser accepts
  check (out, targets = 'all') {
    let data
    try {
      data = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    } catch {
      return { lines: [], parsed: [], error: 'the translator did not answer in JSON' }
    }
    const lines = []
    const parsed = []
    const dropped = []
    for (const line of Array.isArray(data.commands) ? data.commands : []) {
      const p = parseMessage(String(line), this.botNames)
      if (!p || p.type !== 'command') { dropped.push(String(line)); continue }
      // a request to one bot stays with that bot
      if (targets !== 'all' && p.targets === 'all') p.targets = targets
      if (targets !== 'all' && !targets.includes(p.targets[0])) { dropped.push(String(line)); continue }
      lines.push(String(line))
      parsed.push({ targets: p.targets, command: p.command })
    }
    if (dropped.length) this.log(`translator: dropped ${dropped.join(' | ')}`)
    return { lines, parsed, reject: data.reject || null }
  }
}

module.exports = { Translator, loadCredentials, systemPrompt }
