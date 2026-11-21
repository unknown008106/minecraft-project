// Command parser tests, no server needed:  node --test bridge/crew/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseChatLine, parseMessage, resolveBlocks, formatCommand } = require('../commands')
const { Translator } = require('../translator')

const BOTS = ['Crew1', 'Crew2']

test('reads chat lines, with and without the Not Secure tag', () => {
  assert.deepEqual(parseChatLine('<Live_Fonam> !stop'), { sender: 'Live_Fonam', message: '!stop' })
  assert.deepEqual(parseChatLine('[Not Secure] <Live_Fonam> !kill 30'), { sender: 'Live_Fonam', message: '!kill 30' })
  assert.equal(parseChatLine('Live_Fonam joined the game'), null)
  // a player quoting the owner is still that player
  assert.equal(parseChatLine('<Eve> <Live_Fonam> !stop').sender, 'Eve')
})

test('kill takes a radius and a name in any order', () => {
  let p = parseMessage('!kill', BOTS)
  assert.equal(p.type, 'command')
  assert.deepEqual(p.command, { name: 'kill', args: { radius: 50, target: null } })
  p = parseMessage('!kill 30 Steve', BOTS)
  assert.deepEqual(p.command.args, { radius: 30, target: 'Steve' })
  p = parseMessage('!kill Steve 20', BOTS)
  assert.deepEqual(p.command.args, { radius: 20, target: 'Steve' })
  assert.equal(parseMessage('!kill 999', BOTS).command.args.radius, 128)
})

test('addressing one bot, case insensitive', () => {
  const p = parseMessage('!crew1 mine iron 10', BOTS)
  assert.deepEqual(p.targets, ['Crew1'])
  assert.equal(p.command.name, 'mine')
  assert.deepEqual(p.command.args.blocks, ['iron_ore', 'deepslate_iron_ore'])
  assert.equal(p.command.args.count, 10)
  assert.equal(parseMessage('!all stop', BOTS).targets, 'all')
})

test('mine maps ores, plurals and plain block names', () => {
  assert.deepEqual(resolveBlocks('diamond').blocks, ['diamond_ore', 'deepslate_diamond_ore'])
  assert.deepEqual(resolveBlocks('diamonds').blocks, ['diamond_ore', 'deepslate_diamond_ore'])
  assert.deepEqual(resolveBlocks('raw_iron').blocks, ['iron_ore', 'deepslate_iron_ore'])
  assert.deepEqual(resolveBlocks('quartz').blocks, ['nether_quartz_ore'])
  assert.equal(resolveBlocks('logs').blocks.length, 9)
  assert.deepEqual(resolveBlocks('oak_log').blocks, ['oak_log'])
  const p = parseMessage('!mine diamond 5', BOTS)
  assert.deepEqual(p.command.args, { block: 'diamond', blocks: ['diamond_ore', 'deepslate_diamond_ore'], count: 5 })
  assert.equal(parseMessage('!mine coal', BOTS).command.args.count, 5)
  assert.equal(parseMessage('!mine iron ore 3', BOTS).command.args.block, 'iron')
})

test('bad commands are errors, ordinary chat is ignored', () => {
  assert.equal(parseMessage('!dance', BOTS).type, 'error')
  assert.equal(parseMessage('!mine', BOTS).type, 'error')
  assert.equal(parseMessage('!guard far', BOTS).type, 'error')
  assert.equal(parseMessage('!stop now', BOTS).type, 'error')
  assert.equal(parseMessage('!human max', BOTS).type, 'error')
  assert.equal(parseMessage('hello everyone', BOTS), null)
  assert.equal(parseMessage('/gamemode creative', BOTS), null)
})

test('plain words go to the translator', () => {
  assert.deepEqual(parseMessage('@crew go get me some diamonds', BOTS),
    { type: 'translate', targets: 'all', text: 'go get me some diamonds' })
  assert.deepEqual(parseMessage('Crew2, come here please', BOTS),
    { type: 'translate', targets: ['Crew2'], text: 'come here please' })
  assert.equal(parseMessage('@crew', BOTS), null)
})

test('human levels and stances', () => {
  assert.deepEqual(parseMessage('!human full', BOTS).command, { name: 'human', args: { level: 'full' } })
  assert.equal(parseMessage('!guard 8', BOTS).command.args.radius, 8)
  for (const c of ['stop', 'come', 'follow', 'stay', 'status', 'give']) assert.equal(parseMessage(`!${c}`, BOTS).command.name, c)
})

test('formatCommand round trips', () => {
  for (const line of ['!mine diamond 5', '!Crew1 kill 30 Steve', '!guard 8', '!stop', '!human off']) {
    const p = parseMessage(line, BOTS)
    const back = formatCommand(p.targets === 'all' ? 'all' : p.targets[0], p.command)
    assert.deepEqual(parseMessage(back, BOTS), p)
  }
})

test('translator output is checked by the same parser', () => {
  const t = new Translator({ botNames: BOTS, credentials: null })
  assert.equal(t.enabled, false)
  let r = t.check('{"commands": ["!mine diamond 5", "!come", "/op Eve", "!fly"]}')
  assert.deepEqual(r.lines, ['!mine diamond 5', '!come'])
  r = t.check('here: {"commands": ["!mine iron 3"]}', ['Crew2'])
  assert.deepEqual(r.parsed[0].targets, ['Crew2'])
  r = t.check('{"commands": ["!Crew1 come"]}', ['Crew2'])
  assert.equal(r.lines.length, 0)
  r = t.check('{"commands": [], "reject": "cannot build"}')
  assert.equal(r.reject, 'cannot build')
  assert.ok(t.check('not json').error)
})

test('quiet and verbose', () => {
  assert.deepEqual(parseMessage('!quiet', BOTS).command, { name: 'quiet', args: {} })
  assert.deepEqual(parseMessage('!verbose', BOTS).command, { name: 'verbose', args: {} })
  assert.equal(parseMessage('!quiet please', BOTS).type, 'error')
})

test('build, farm, expand, explore, design and blueprints', () => {
  const { SOLO } = require('../commands')
  let p = parseMessage('!build small_hut here', BOTS)
  assert.deepEqual(p.command, { name: 'build', args: { blueprint: 'small_hut', site: 'here', facing: null } })
  p = parseMessage('!Crew2 build wheat_farm 10 64 -20 east', BOTS)
  assert.deepEqual(p.targets, ['Crew2'])
  assert.deepEqual(p.command.args, { blueprint: 'wheat_farm', site: [10, 64, -20], facing: 'east' })
  assert.deepEqual(parseMessage('!farm', BOTS).command.args, { crop: 'wheat', here: false })
  assert.deepEqual(parseMessage('!farm here potatoes', BOTS).command.args, { crop: 'potato', here: true })
  assert.equal(parseMessage('!farm corn', BOTS).type, 'error')
  assert.equal(parseMessage('!build hut 1 2 3 up', BOTS).type, 'error')
  assert.deepEqual(parseMessage('!expand wheat_farm', BOTS).command.args, { build: 'wheat_farm' })
  assert.equal(parseMessage('!explore', BOTS).command.args.radius, 64)
  assert.equal(parseMessage('!explore 500', BOTS).command.args.radius, 256)
  assert.deepEqual(parseMessage('!design tower a 5 by 5 stone tower', BOTS).command.args, { blueprint: 'tower', words: 'a 5 by 5 stone tower' })
  assert.equal(parseMessage('!blueprints', BOTS).command.name, 'blueprints')
  for (const n of ['build', 'farm', 'expand', 'explore', 'design']) assert.ok(SOLO.has(n))
  for (const line of ['!build small_hut here', '!build wall 1 70 2 south', '!farm carrot here', '!expand wall', '!explore 32', '!design hall a long oak hall']) {
    const q = parseMessage(line, BOTS)
    assert.deepEqual(parseMessage(formatCommand('all', q.command), BOTS).command, q.command)
  }
})

test('the translator knows the blueprints and when to design a new one', () => {
  const { systemPrompt } = require('../translator')
  const text = systemPrompt(BOTS, [{ name: 'small_hut', description: 'a hut' }, { name: 'wheat_farm', description: 'the village farm' }])
  assert.match(text, /small_hut: a hut/)
  assert.match(text, /!build <blueprint> \[here \| x y z\]/)
  assert.match(text, /!design <new_name>/)
  const t = new Translator({ botNames: BOTS, credentials: null })
  const r = t.check('{"commands": ["!build small_hut here", "!farm wheat here", "!design tower a stone tower", "!build tower here"]}')
  assert.equal(r.parsed.length, 4)
  assert.deepEqual(r.parsed[0].command.args, { blueprint: 'small_hut', site: 'here', facing: null })
})
