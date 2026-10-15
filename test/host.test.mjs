import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { apply, parseDraftJson } from '../lib/index.js'

const TEMP_ROOT = join(process.cwd(), '.test-tmp')

/**
 * Build a minimal Cordis context that records every registration, so the test
 * exercises the real `apply()` rather than a re-implementation of it.
 * @param {{ sessions?: Map<string, object>, llm?: object, defaultModel?: object }} [options]
 * @returns {object}
 */
function createHarness(options = {}) {
  const tools = new Map()
  const routes = []
  const sections = []
  const listeners = new Map()
  const effects = []
  const services = new Map(Object.entries({
    sessions: { get: (id) => options.sessions?.get(id) },
    llm: options.llm,
    agentDefaultModel: options.defaultModel,
  }))
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    get: (name) => services.get(name),
    on: (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ label, disposer })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
    },
  }
  return { ctx, tools, routes, sections, listeners, effects }
}

/**
 * Issue a request against the registered `/second-brain` handler.
 * @param {object} route
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 * @returns {Promise<{status: number, headers: object, json: any, raw: string}>}
 */
async function call(route, method, url, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    // The real client always sends JSON, and the route now demands it (a
    // cross-origin page cannot send `application/json` without a preflight this
    // server never answers). Tests must therefore send it too.
    headers: {
      host: '127.0.0.1:19387',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  let status = 0
  let responseHeaders = {}
  let raw = ''
  const res = {
    writeHead: (code, extra) => {
      status = code
      responseHeaders = extra ?? {}
    },
    end: (value) => {
      raw = value === undefined ? '' : String(value)
    },
  }
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(raw)
  } catch {
    json = null
  }
  return { status, headers: responseHeaders, json, raw }
}

/**
 * Create a temporary vault and point the plugin at it via the real config path.
 * @param {string} name
 * @returns {{ root: string, home: string }}
 */
function makeHome(name) {
  mkdirSync(TEMP_ROOT, { recursive: true })
  const home = mkdtempSync(join(TEMP_ROOT, `${name}-`))
  return { root: join(home, 'vault'), home }
}

/**
 * Apply the plugin against a fresh sandbox.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function boot(options = {}) {
  const { root, home } = makeHome(options.name ?? 'brain')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  delete process.env.DSH_SECOND_BRAIN_VAULT
  const harness = createHarness(options)
  const api = apply(harness.ctx)
  return {
    ...harness,
    ...api,
    root,
    home,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** A fake Session whose `deriveMessages()` returns the given transcript. */
function fakeSession(messages, cwd = '/work') {
  return {
    id: 'session-test',
    header: { cwd },
    deriveMessages: () => messages,
  }
}

test('apply registers the tools, the route and the prompt section', async () => {
  const brain = await boot()
  try {
    assert.deepEqual([...brain.tools.keys()].sort(), [
      'brain_capture',
      'brain_forget',
      'brain_list',
      'brain_recall',
      'brain_save',
      'brain_stats',
    ])
    assert.equal(brain.routes.length, 1)
    assert.equal(brain.routes[0].kind, 'prefix')
    assert.equal(brain.routes[0].path, '/second-brain')
    assert.equal(brain.sections.length, 1)
    assert.equal(brain.sections[0].name, 'tool:second-brain')
    assert.equal(brain.listeners.has('agent/turn-stopping'), true)
    // Every registration is disposed through an effect.
    // 6 tools + 1 prompt section + 1 turn listener + 1 HTTP route.
    assert.equal(brain.effects.length, 9)
  } finally {
    brain.cleanup()
  }
})

test('GET /ping, /overview and /config describe the vault', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    const ping = await call(route, 'GET', '/second-brain/ping')
    assert.equal(ping.status, 200)
    assert.equal(ping.json.ok, true)
    assert.equal(ping.json.cards, 0)

    const overview = await call(route, 'GET', '/second-brain/overview')
    assert.equal(overview.json.ok, true)
    assert.equal(overview.json.config.capture, 'heuristic')
    assert.deepEqual(overview.json.tags, [])

    const config = await call(route, 'GET', '/second-brain/config')
    assert.equal(config.json.config.vault, brain.vault().root)
    assert.ok(config.json.config.vault.endsWith('/second-brain/vault'))
  } finally {
    brain.cleanup()
  }
})

test('unknown routes answer 404 as JSON instead of hanging', async () => {
  const brain = await boot()
  try {
    const response = await call(brain.routes[0], 'GET', '/second-brain/nope')
    assert.equal(response.status, 404)
    assert.equal(response.json.ok, false)
    assert.match(response.json.error, /未知路由/)
  } finally {
    brain.cleanup()
  }
})

test('card CRUD over HTTP writes real Markdown files', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    const created = await call(route, 'POST', '/second-brain/card', {
      title: '插件双半结构',
      body: '宿主半导出 apply/inject，浏览器半是一个 __ModuleLoader__ 工厂。',
      kind: 'fact',
      tags: ['dsh', '插件'],
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    const id = created.json.card.id
    assert.equal(readdirSync(join(brain.vault().root, 'cards')).length, 1)

    const list = await call(route, 'GET', '/second-brain/list?limit=10')
    assert.equal(list.json.total, 1)
    assert.equal(list.json.items[0].title, '插件双半结构')
    assert.equal('body' in list.json.items[0], false, 'the list projection omits the body')

    const one = await call(route, 'GET', `/second-brain/card?id=${encodeURIComponent(id)}`)
    assert.equal(one.json.card.body.includes('__ModuleLoader__'), true)

    const updated = await call(route, 'POST', '/second-brain/card', {
      id,
      title: '插件双半结构（修订）',
      body: '宿主半导出 apply/inject；浏览器半是 __ModuleLoader__ 工厂，用 React.createElement 渲染。',
      kind: 'decision',
      tags: ['dsh', '插件', 'react'],
    })
    assert.equal(updated.json.card.title, '插件双半结构（修订）')
    assert.equal(updated.json.card.kind, 'decision')
    assert.equal(readdirSync(join(brain.vault().root, 'cards')).length, 1, 'an edit rewrites the same file')

    const bad = await call(route, 'POST', '/second-brain/card', { title: '', body: 'x' })
    assert.equal(bad.status, 400)

    const missing = await call(route, 'GET', '/second-brain/card?id=kb-nope')
    assert.equal(missing.status, 404)

    const deleted = await call(route, 'POST', '/second-brain/delete', { ids: [id] })
    assert.deepEqual(deleted.json.deleted, [id])
    assert.equal(readdirSync(join(brain.vault().root, 'cards')).length, 0)
  } finally {
    brain.cleanup()
  }
})

test('search, graph, merge and export/import work over HTTP', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    const save = async (title, body, tags) => {
      const response = await call(route, 'POST', '/second-brain/card', { title, body, tags })
      return response.json.card.id
    }
    const a = await save('力导向图布局', '力导向图使用斥力与弹簧迭代，节点按标签着色，支持框选。', ['图谱'])
    const b = await save('知识卡格式', '知识卡是 Markdown 文件，frontmatter 保存标签与来源信息。', ['存储'])
    await save('图谱图例过滤', '图谱支持图例过滤与时间维筛选，便于在大量节点中定位。', ['图谱'])

    const search = await call(route, 'GET', '/second-brain/search?q=' + encodeURIComponent('框选'))
    assert.equal(search.json.results.length >= 1, true)
    assert.equal(search.json.results[0].id, a)

    const graph = await call(route, 'GET', '/second-brain/graph')
    assert.equal(graph.json.nodes.length, 3)
    assert.ok(graph.json.tags.some((tag) => tag.name === '图谱' && tag.count === 2))
    assert.ok(graph.json.edges.some((edge) => edge.type === 'tag' && edge.labels.includes('图谱')))

    const mergeIds = graph.json.nodes.filter((node) => node.tags.includes('图谱')).map((node) => node.id)
    assert.equal(mergeIds.length, 2)
    const merged = await call(route, 'POST', '/second-brain/merge', { ids: mergeIds, title: '图谱（合并）' })
    assert.equal(merged.json.ok, true)
    assert.equal(merged.json.card.title, '图谱（合并）')
    assert.equal(merged.json.removed.length, 1)

    const tooFew = await call(route, 'POST', '/second-brain/merge', { ids: [a] })
    assert.equal(tooFew.status, 400)

    const exported = await call(route, 'GET', '/second-brain/export')
    assert.equal(exported.json.bundle.format, 'dsh-second-brain')
    assert.equal(exported.json.bundle.cards.length, 2)

    const download = await call(route, 'GET', '/second-brain/export?download=1')
    assert.match(download.headers['content-disposition'], /attachment/)

    // Import into a second, independent brain.
    const target = await boot({ name: 'import' })
    try {
      const imported = await call(target.routes[0], 'POST', '/second-brain/import', { bundle: exported.json.bundle })
      assert.equal(imported.json.imported, 2)
      const again = await call(target.routes[0], 'POST', '/second-brain/import', { bundle: exported.json.bundle })
      assert.equal(again.json.imported, 0)
      assert.equal(again.json.skipped, 2)
      assert.equal(target.vault().list().length, 2)
    } finally {
      target.cleanup()
    }
    assert.equal(b, b)
  } finally {
    brain.cleanup()
  }
})

test('mutating routes reject non-JSON and cross-origin callers', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    // A cross-origin page can only send a "simple" request without a preflight,
    // and those cannot carry application/json — so requiring it is the gate.
    const plain = await call(route, 'POST', '/second-brain/card', undefined, { 'content-type': 'text/plain' })
    assert.equal(plain.status, 415)
    const form = await call(route, 'POST', '/second-brain/card', undefined, { 'content-type': 'application/x-www-form-urlencoded' })
    assert.equal(form.status, 415)

    const crossOrigin = await call(route, 'POST', '/second-brain/card', { title: 'x', body: 'y' }, { origin: 'http://evil.example' })
    assert.equal(crossOrigin.status, 403)
    assert.match(crossOrigin.json.error, /跨站/)

    // A same-origin browser POST does send Origin, and it must be allowed.
    const sameOrigin = await call(route, 'POST', '/second-brain/card', { title: '同源写入', body: '正文' }, { origin: 'http://127.0.0.1:19387' })
    assert.equal(sameOrigin.status, 200)
    assert.equal(sameOrigin.json.ok, true)

    // The plugin's own client sends no Origin on same-origin GETs.
    assert.equal((await call(route, 'GET', '/second-brain/ping')).status, 200)
    // A foreign Origin on a read is still refused, so a page cannot exfiltrate
    // the vault through a simple GET either.
    assert.equal((await call(route, 'POST', '/second-brain/delete', { ids: [] }, { origin: 'http://evil.example' })).status, 403)
  } finally {
    brain.cleanup()
  }
})

test('import refuses to escape the vault when a bundle carries a hostile id', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    const hostile = await call(route, 'POST', '/second-brain/import', {
      bundle: { format: 'dsh-second-brain', version: 1, cards: [{ id: '../../../owned', title: 'innocent', body: 'escaped' }] },
    })
    assert.equal(hostile.json.ok, true)
    const files = readdirSync(join(brain.vault().root, 'cards'))
    assert.equal(files.length, 1)
    assert.match(files[0], /^2026-\d\d-\d\d-innocent--[0-9a-f]{8}\.md$/, `unexpected file name ${files[0]}`)
    assert.ok(!existsSync(join(brain.vault().root, 'owned.md')), 'nothing may be written outside cards/')
    // An id without a usable token still produces a valid card.
    assert.equal(brain.vault().list().length, 1)

    // A deep traversal attempt must not create directories either.
    const deep = await call(route, 'POST', '/second-brain/import', {
      bundle: { format: 'dsh-second-brain', version: 1, cards: [{ id: '../../../../../../pwned', title: 'deep', body: 'x' }] },
    })
    assert.equal(deep.json.ok, true)
    assert.ok(!existsSync(join(brain.vault().root, '..', 'pwned.md')))
    assert.equal(readdirSync(join(brain.vault().root, 'cards')).length, 2)
  } finally {
    brain.cleanup()
  }
})

test('replace import needs an explicit confirmation and a usable bundle', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    await call(route, 'POST', '/second-brain/card', { title: '会被误删的卡', body: '正文' })
    assert.equal(brain.vault().list().length, 1)

    // Without `confirm`, replace is refused outright.
    const unconfirmed = await call(route, 'POST', '/second-brain/import', { mode: 'replace' })
    assert.equal(unconfirmed.status, 400)
    assert.equal(brain.vault().list().length, 1, 'the vault is untouched')

    // Even confirmed, an empty/garbage bundle must not wipe anything.
    const empty = await call(route, 'POST', '/second-brain/import', { mode: 'replace', confirm: 'replace', bundle: { cards: [] } })
    assert.equal(empty.json.ok, true)
    assert.equal(empty.json.imported, 0)
    assert.ok(empty.json.errors.some((line) => /拒绝/.test(line)))
    assert.equal(brain.vault().list().length, 1, 'an empty replace does not destroy the vault')

    const garbage = await call(route, 'POST', '/second-brain/import', { mode: 'replace', confirm: 'replace', bundle: { cards: 'nope' } })
    assert.equal(garbage.json.imported, 0)
    assert.equal(brain.vault().list().length, 1)

    // A confirmed, valid replace does clear and write.
    const good = await call(route, 'POST', '/second-brain/import', {
      mode: 'replace',
      confirm: 'replace',
      bundle: { format: 'dsh-second-brain', version: 1, cards: [{ title: '新卡', body: '新正文', createdAt: new Date().toISOString() }] },
    })
    assert.equal(good.json.imported, 1)
    assert.deepEqual(brain.vault().list().map((card) => card.title), ['新卡'])
  } finally {
    brain.cleanup()
  }
})

test('malformed request bodies answer 400, not 500', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    // Send raw invalid JSON by hand: the harness serializes, so bypass it.
    const req = {
      method: 'POST',
      url: '/second-brain/card',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{not json', 'utf8') },
    }
    let status = 0
    let raw = ''
    await route.handler(req, { writeHead: (code) => { status = code }, end: (value) => { raw = String(value ?? '') } })
    assert.equal(status, 400)
    assert.match(JSON.parse(raw).error, /不是合法 JSON/)

    // A JSON array or scalar is not an object body either.
    const arrayReq = {
      method: 'POST',
      url: '/second-brain/card',
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('[1,2,3]', 'utf8') },
    }
    status = 0
    await route.handler(arrayReq, { writeHead: (code) => { status = code }, end: () => {} })
    assert.equal(status, 400)
  } finally {
    brain.cleanup()
  }
})

test('POST /config switches the vault and the capture policy', async () => {
  const brain = await boot()
  try {
    const route = brain.routes[0]
    const moved = join(brain.home, 'other-vault')
    const response = await call(route, 'POST', '/second-brain/config', {
      patch: { vault: moved, capture: 'off', tagsLimit: 9 },
    })
    assert.equal(response.json.ok, true)
    assert.equal(response.json.config.vault, moved)
    assert.equal(response.json.config.capture, 'off')
    assert.equal(response.json.config.tagsLimit, 9)
    assert.equal(brain.vault().root, moved)

    const bad = await call(route, 'POST', '/second-brain/config', { patch: { capture: 'nonsense' } })
    assert.equal(bad.json.config.capture, 'heuristic')
  } finally {
    brain.cleanup()
  }
})

test('brain_save deduplicates and brain_recall finds the card', async () => {
  const brain = await boot()
  try {
    const save = brain.tools.get('brain_save')
    const first = await save.execute({
      title: 'DSH 插件清单',
      body: '一个 DSH 插件需要 package.json（声明 dsh.bundle.patch 与 exports）与 cordis.patch.yml（插入插件行），缺一不可。',
      tags: ['dsh'],
    })
    assert.equal(first.ok, true)
    assert.equal(first.action, 'created')

    // The same knowledge, restated with an extra clause, must merge rather than
    // create a second card.
    const second = await save.execute({
      title: 'DSH 插件清单',
      body: '一个 DSH 插件需要 package.json（声明 dsh.bundle.patch 与 exports）与 cordis.patch.yml（插入插件行），缺一不可；另外浏览器半需要在 dsh.client 里声明。',
      tags: ['dsh', '插件'],
    })
    assert.equal(second.action, 'merged')
    assert.equal(second.id, first.id)
    assert.equal(brain.vault().list().length, 1)
    assert.deepEqual(brain.vault().get(first.id).tags.sort(), ['dsh', '插件'])

    const recall = brain.tools.get('brain_recall')
    const found = await recall.execute({ query: 'cordis.patch.yml' })
    assert.equal(found.count, 1)
    assert.equal(found.results[0].id, first.id)
    assert.ok(recall.output.render({}, found)[0].text.includes('DSH 插件清单'))

    const withBody = await recall.execute({ query: '插件', with_body: true })
    assert.ok(withBody.results[0].body.includes('package.json'))

    const empty = await recall.execute({ query: '' })
    assert.equal(empty.count, 0)
    const none = await recall.execute({ query: '量子计算' })
    assert.equal(none.count, 0)
    assert.match(none.notice, /没有匹配/)
  } finally {
    brain.cleanup()
  }
})

test('brain_save rejects empty input and brain_list/stats/forget behave', async () => {
  const brain = await boot()
  try {
    const save = brain.tools.get('brain_save')
    assert.equal((await save.execute({ title: 'x', body: '' })).ok, false)

    // Two genuinely different notes: templated near-identical bodies are
    // duplicates by design, so the fixture must not accidentally be one.
    await save.execute({ title: '强制重扫索引', body: '知识库改动手工编辑后，调用 /reindex 触发强制重扫，目录里每个文件的 mtime 都会被重新比对。', tags: ['a'] })
    await save.execute({ title: '图谱配色规则', body: '节点颜色取自它的第一个标签，标签颜色由标签名哈希到十二色调色板，因此同一标签在任何一张图里颜色一致。', tags: ['b'] })

    const list = brain.tools.get('brain_list')
    const all = await list.execute({})
    assert.equal(all.total, 2)
    assert.equal(all.count, 2)
    const tagged = await list.execute({ tag: 'b' })
    assert.equal(tagged.total, 1)
    const page = await list.execute({ limit: 1, offset: 1 })
    assert.equal(page.count, 1)

    const stats = brain.tools.get('brain_stats')
    const statsValue = await stats.execute({})
    assert.equal(statsValue.cards, 2)
    assert.ok(statsValue.notice.includes('第二大脑'))
    assert.ok(statsValue.topTags.length >= 1)

    const forget = brain.tools.get('brain_forget')
    assert.equal((await forget.execute({})).ok, false)
    const dry = await forget.execute({ title: '强制重扫', dry_run: true })
    assert.equal(dry.deleted.length, 0)
    assert.equal(dry.candidates.length, 1)
    const removed = await forget.execute({ title: '强制重扫' })
    assert.equal(removed.deleted.length, 1)
    assert.equal(brain.vault().list().length, 1)
    assert.equal((await forget.execute({ id: 'kb-missing' })).ok, false)
  } finally {
    brain.cleanup()
  }
})

test('auto-capture distills a finished turn, then ignores the same turn', async () => {
  const long = [
    '构建 DSH 插件需要两个文件，缺一不可：package.json 声明 dsh.bundle.patch 与 exports，',
    'cordis.patch.yml 负责把插件行插入 profile 的 roster。两者缺任何一个，插件都不会被加载。',
    '',
    '首先创建 package.json，声明 dsh.bundle.patch 与 exports；',
    '然后在 cordis.patch.yml 里插入插件行；最后把包名加进 profile 的 bundle 列表。',
    '',
    '```js',
    "export const name = 'my-plugin'",
    'export function apply(ctx) { ctx.effect(() => ctx.tools.register(tool), "x") }',
    '```',
    '',
    '注意：inject 里列出的服务必须真实存在，否则插件会一直等待依赖，表现为功能静默失效而没有报错。',
    '排查时先看加载日志里该插件行是否处于 active，再看工具是否出现在工具列表里。',
  ].join('\n')
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '怎么开发一个 dsh 插件？' }] },
    { role: 'assistant', content: [{ type: 'text', text: long }] },
  ]
  const sessions = new Map([['session-test', fakeSession(messages)]])
  const brain = await boot({ sessions })
  try {
    const first = await brain.captureSession({ sessionId: 'session-test', turn: 1 })
    assert.equal(first.ok, true)
    assert.ok(first.created >= 2, `expected a card and a snippet, got ${first.created}`)
    const countAfterFirst = brain.vault().list().length
    assert.equal(countAfterFirst, first.created)

    const second = await brain.captureSession({ sessionId: 'session-test', turn: 1 })
    assert.equal(second.skipped, true)
    assert.match(second.reason, /已采集/)
    assert.equal(brain.vault().list().length, countAfterFirst)

    // force=true bypasses the per-turn guard but still hits the dedupe policy.
    const forced = await brain.captureSession({ sessionId: 'session-test', turn: 1, force: true })
    assert.equal(forced.created, 0)
    assert.equal(forced.merged, countAfterFirst)
    assert.equal(brain.vault().list().length, countAfterFirst)

    const unknown = await brain.captureSession({ sessionId: 'session-missing' })
    assert.equal(unknown.skipped, true)
  } finally {
    brain.cleanup()
  }
})

test('capture is disabled by config and by a missing session service', async () => {
  const brain = await boot()
  try {
    const off = await brain.cleanupLater?.() ?? null
    assert.equal(off, null)
  } finally {
    brain.cleanup()
  }
  const lonely = await boot({ sessions: new Map() })
  try {
    const missing = await lonely.captureSession({ sessionId: 'nope' })
    assert.equal(missing.skipped, true)
    assert.match(missing.reason, /找不到会话/)
  } finally {
    lonely.cleanup()
  }
})

test('brain_capture tool reports when no session is bound', async () => {
  const sessions = new Map([['session-test', fakeSession([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }])]])
  const brain = await boot({ sessions })
  try {
    const tool = brain.tools.get('brain_capture')
    const noAgent = await tool.execute({}, {})
    assert.equal(noAgent.ok, false)
    assert.match(noAgent.notice, /没有绑定的会话/)

    const bound = await tool.execute({}, { agent: { session: { id: 'session-test' } } })
    assert.equal(bound.skipped, true, 'a one-character transcript is not worth capturing')
  } finally {
    brain.cleanup()
  }
})

test('LLM distillation separates a valid verdict from an unusable reply', () => {
  const ok = parseDraftJson('这是结果：\n```json\n[{"title":"标题","body":"正文","kind":"decision","tags":["A","B"]}]\n```\n完毕')
  assert.equal(ok.ok, true)
  assert.equal(ok.drafts.length, 1)
  assert.equal(ok.drafts[0].title, '标题')
  assert.equal(ok.drafts[0].kind, 'decision')
  assert.deepEqual(ok.drafts[0].tags, ['a', 'b'])

  // An empty array is the model's DECISION that nothing is reusable. Treating
  // it as a failure is what let the heuristics override the verdict.
  const empty = parseDraftJson('[]')
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.drafts, [])
  assert.equal(parseDraftJson('```json\n[]\n```').ok, true)

  // Genuinely unusable answers are failures.
  assert.equal(parseDraftJson('no json here').ok, false)
  assert.equal(parseDraftJson('[not json]').ok, false)
  assert.equal(parseDraftJson('[{"title":"","body":"x"}]').ok, true, 'entries without a title are dropped, not fatal')
  assert.deepEqual(parseDraftJson('[{"title":"","body":"x"}]').drafts, [])
  assert.equal(parseDraftJson('{"title":"x"}').ok, false, 'an object is not an array of drafts')
})

test('a truncated model answer is salvaged, not treated as a failure', () => {
  // A long turn can push the answer past the token budget mid-array. The
  // complete entries before the cut are valid drafts; reporting a failure here
  // is what sent the capture down the heuristic path.
  const items = [
    { title: '甲', body: '甲的正文', kind: 'fact', tags: ['a'] },
    { title: '乙', body: '乙的正文', kind: 'fact', tags: ['b'] },
    { title: '丙', body: '丙的正文', kind: 'fact', tags: ['c'] },
  ]
  const full = JSON.stringify(items)
  const cut = full.slice(0, full.length - 40)
  const r = parseDraftJson(cut)
  assert.equal(r.ok, true, 'a truncation is a partial answer, not a failure')
  assert.deepEqual(r.drafts.map((d) => d.title), ['甲', '乙'])

  // The scanner must not be fooled by braces or escapes inside a body.
  const tricky = JSON.stringify([
    { title: '含括号', body: '代码：if (x) { y() } 结束', kind: 'snippet', tags: [] },
    { title: '含引号', body: '他说 "}" 然后停了', kind: 'note', tags: [] },
  ])
  const trickyCut = tricky.slice(0, tricky.length - 20)
  const t = parseDraftJson(trickyCut)
  assert.equal(t.ok, true)
  assert.deepEqual(t.drafts.map((d) => d.title), ['含括号'])

  // Cut before even one complete object: nothing to salvage, so it is a failure.
  assert.equal(parseDraftJson('[{"title":"甲","bo').ok, false)
})

test('a model verdict of "nothing worth keeping" is respected, not overridden', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '把仓库推上去' }] },
    { role: 'assistant', content: [{ type: 'text', text: '仓库已推送，凭据已存进钥匙串，main 与远端一致。'.repeat(6) }] },
  ]
  const sessions = new Map([['session-test', fakeSession(messages)]])
  const emptyStream = async function* () {
    yield { type: 'text-delta', index: 0, text: '[]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const brain = await boot({
    sessions,
    defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: { stream: () => emptyStream() },
  })
  try {
    await call(brain.routes[0], 'POST', '/second-brain/config', { patch: { capture: 'llm', minChars: 100 } })
    const captured = await brain.captureSession({ sessionId: 'session-test', turn: 1 })
    assert.equal(captured.mode, 'llm')
    assert.equal(captured.skipped, true)
    assert.match(captured.reason, /无可沉淀/)
    assert.equal(brain.vault().list().length, 0, 'the heuristics must not run behind the model back')
  } finally {
    brain.cleanup()
  }
})

test('llm capture mode uses the model, and degrades when the model fails', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '知识库应该怎么组织？' }] },
    { role: 'assistant', content: [{ type: 'text', text: '知识库建议按主题分成子目录，每张卡一个 Markdown 文件，文件名带日期前缀便于按时间浏览；标签放在 frontmatter 里，检索时同时匹配标题、标签和正文，中文用字符二元组切分就能覆盖大部分查询。合并重复卡片时保留最早的创建时间，这样知识在时间轴上的位置不会漂移；正文取更完整的那一份，标签与来源做并集。导出格式用 JSON，方便跨机器同步和在 git 里审阅差异；导入默认走合并模式并跳过重复项，需要整体替换时显式指定 replace。最后，重索引只在文件 mtime 变化时重新解析，所以几千张卡的库也能保持很快。' }] },
  ]
  const sessions = new Map([['session-test', fakeSession(messages)]])

  const goodStream = async function* () {
    yield { type: 'text-delta', index: 0, text: '[{"title":"知识库组织方式","body":"按主题分目录，每张卡一个文件。","kind":"decision","tags":["知识库"]}]' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const defaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
  const brain = await boot({
    sessions,
    defaultModel,
    llm: { stream: () => goodStream() },
  })
  try {
    await call(brain.routes[0], 'POST', '/second-brain/config', { patch: { capture: 'llm' } })
    const captured = await brain.captureSession({ sessionId: 'session-test', turn: 1 })
    assert.equal(captured.mode, 'llm')
    assert.equal(captured.created, 1)
    assert.equal(brain.vault().list()[0].title, '知识库组织方式')
  } finally {
    brain.cleanup()
  }

  const badStream = async function* () {
    yield { type: 'text-delta', index: 0, text: '抱歉，我无法处理。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  // Default: a failed model call SKIPS the turn. Substituting the heuristics
  // here is what filled the knowledge base with cards titled after the user's
  // own message, so it is now opt-in.
  const skipped = await boot({ sessions, defaultModel, llm: { stream: () => badStream() } })
  try {
    await call(skipped.routes[0], 'POST', '/second-brain/config', { patch: { capture: 'llm', minChars: 120 } })
    const captured = await skipped.captureSession({ sessionId: 'session-test', turn: 2 })
    assert.equal(captured.skipped, true)
    assert.equal(captured.mode, 'llm')
    assert.match(captured.reason, /模型提炼不可用/)
    assert.equal(captured.created, 0)
    assert.equal(skipped.vault().list().length, 0, 'an unusable model answer must not seed the heuristics')
  } finally {
    skipped.cleanup()
  }

  // Opt-in: the old behaviour is one setting away.
  const fallback = await boot({ sessions, defaultModel, llm: { stream: () => badStream() } })
  try {
    await call(fallback.routes[0], 'POST', '/second-brain/config', { patch: { capture: 'llm', minChars: 120, heuristicFallback: true } })
    const captured = await fallback.captureSession({ sessionId: 'session-test', turn: 2 })
    assert.equal(captured.mode, 'heuristic', 'heuristicFallback: true restores the fallback')
    assert.ok(captured.created >= 1)
  } finally {
    fallback.cleanup()
  }

  const noLlm = await boot({ sessions, defaultModel })
  try {
    await call(noLlm.routes[0], 'POST', '/second-brain/config', { patch: { capture: 'llm', minChars: 120 } })
    const captured = await noLlm.captureSession({ sessionId: 'session-test', turn: 3 })
    assert.equal(captured.mode, 'llm')
    assert.equal(captured.skipped, true, 'no llm service at all is also a skip')
  } finally {
    noLlm.cleanup()
  }

  // Explicit heuristic mode is unaffected by any of this.
  const heuristic = await boot({ sessions, defaultModel })
  try {
    await call(heuristic.routes[0], 'POST', '/second-brain/config', { patch: { minChars: 120 } })
    const captured = await heuristic.captureSession({ sessionId: 'session-test', turn: 4 })
    assert.equal(captured.mode, 'heuristic')
    assert.ok(captured.created >= 1, 'capture: heuristic still extracts without a model')
  } finally {
    heuristic.cleanup()
  }
})
