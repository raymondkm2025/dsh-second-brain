import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGraph,
  safeIdToken,
  buildSearchIndex,
  cardFileName,
  compareCards,
  exactSimilarity,
  contentHash,
  exportBundle,
  extractTags,
  importBundle,
  jaccardEstimate,
  makeId,
  matchesInOrder,
  mergeCards,
  minhash,
  normalizeCard,
  normalizeText,
  parseCard,
  searchIndex,
  serializeCard,
  shingles,
  slugify,
  snippet,
  summarize,
  tokenize,
} from '../lib/core.js'

test('tokenize: latin words, identifiers and numbers', () => {
  assert.deepEqual(tokenize('Hello world'), ['hello', 'world'])
  // A compound identifier stays whole for exact match *and* emits its parts so
  // a query for "save" still retrieves it.
  assert.deepEqual(tokenize('ctx.webServer.save()'), ['ctx.webserver.save', 'ctx', 'webserver', 'save'])
  assert.deepEqual(tokenize('lib/core.js and foo-bar_baz'), ['lib/core.js', 'lib', 'core', 'foo-bar_baz'])
  assert.ok(tokenize('version 2.5.1').includes('2.5.1'))
  assert.deepEqual(tokenize('The and of'), [], 'stopwords are dropped from the token stream')
})

test('tokenize: CJK runs become adjacent bigrams with a short-run unit', () => {
  const tokens = tokenize('知识图谱')
  assert.deepEqual(tokens, ['知识', '识图', '图谱', '知识图谱'])
  assert.deepEqual(tokenize('中'), ['中'])
  assert.deepEqual(tokenize('深度学习'), ['深度', '度学', '学习', '深度学习'])
})

test('tokenize: mixed CJK and latin keeps both, in order', () => {
  const tokens = tokenize('用 DSH 搭建第二大脑')
  assert.ok(tokens.includes('dsh'))
  assert.ok(tokens.includes('第二'))
  assert.ok(tokens.includes('二大'))
  assert.ok(tokens.includes('大脑'))
})

test('tokenize: hangul stays a word, not a bigram run', () => {
  assert.deepEqual(tokenize('안녕하세요 세계'), ['안녕하세요', '세계'])
})

test('normalizeText and contentHash are stable across trivial formatting drift', () => {
  assert.equal(normalizeText('Hello   **World**!'), 'hello world')
  assert.equal(contentHash('A  b\n'), contentHash('a b'))
  assert.notEqual(contentHash('a b'), contentHash('a b c'))
})

test('shingles and MinHash: near-identical text scores high, unrelated scores low', () => {
  const a = '本地 Markdown 知识卡使用 YAML frontmatter 存储元数据，正文是 Markdown。'
  const b = '本地 Markdown 知识卡使用 YAML frontmatter 存储元数据，正文为 Markdown 文本。'
  const c = '今天天气不错，适合出门散步，顺便买点水果回来。'
  const simA = jaccardEstimate(minhash(a).sig, minhash(b).sig)
  const simC = jaccardEstimate(minhash(a).sig, minhash(c).sig)
  assert.ok(simA > 0.65, `near-duplicate similarity should be high, got ${simA}`)
  assert.ok(simC < 0.25, `unrelated similarity should be low, got ${simC}`)
  assert.ok(shingles(tokenize(a)).length > 0)
})

test('compareCards: hash beats everything, exact text beats MinHash', () => {
  const a = '本地 Markdown 知识卡使用 YAML frontmatter 存储元数据，正文是 Markdown。'
  const appended = '本地 Markdown 知识卡使用 YAML frontmatter 存储元数据，正文是 Markdown，缺一不可。'
  const far = '桂林山水甲天下，阳朔山水甲桂林。'
  assert.equal(compareCards({ hash: 'h', text: a }, { hash: 'h', text: far }).verdict, 'exact')
  assert.equal(compareCards({ hash: 'h', text: a }, { hash: 'h2', text: far }).verdict, 'distinct')
  // Appended clause: mediocre Jaccard but full containment — still a duplicate.
  const dup = compareCards({ hash: 'h', text: a }, { hash: 'h2', text: appended })
  assert.equal(dup.verdict, 'duplicate')
  assert.equal(dup.basis, 'exact')
  assert.equal(dup.containment, 1)
  // Identical text under different hashes is still a duplicate, decided exactly.
  assert.equal(compareCards({ hash: 'h', text: far }, { hash: 'h2', text: far }).verdict, 'duplicate')
})

test('compareCards falls back to the MinHash estimate without text', () => {
  const a = '本地 Markdown 知识卡使用 YAML frontmatter 存储元数据，正文是 Markdown。'
  const far = '桂林山水甲天下，阳朔山水甲桂林。'
  const verdict = compareCards({ hash: 'h', sig: minhash(a).sig }, { hash: 'h2', sig: minhash(far).sig })
  assert.equal(verdict.basis, 'minhash')
  assert.equal(verdict.verdict, 'distinct')
})

test('exactSimilarity reports Jaccard and containment separately', () => {
  const base = 'DSH 插件需要 package.json 与 cordis.patch.yml 两个文件'
  const longer = `${base}，缺一不可，否则插件不会被加载`
  const exact = exactSimilarity(base, longer)
  assert.ok(exact.jaccard > 0.5 && exact.jaccard < 1)
  assert.equal(exact.containment, 1)
  assert.deepEqual(exactSimilarity('', 'x'), { jaccard: 0, containment: 0, leftTokens: 0, rightTokens: 1 })
})

test('safeIdToken neutralizes hostile ids and keeps clean ones', () => {
  // The raw last path segment would let an imported bundle write anywhere.
  assert.equal(safeIdToken('kb-20261013-abcdef'), 'abcdef')
  assert.equal(safeIdToken('kb-g'), 'g')
  for (const hostile of ['../../../owned', '../../../../../../pwned', 'a/../b', '..', '.', '', 'x/y', 'a\\b', 'a\u0000b']) {
    const token = safeIdToken(hostile, 'seed')
    assert.match(token, /^[A-Za-z0-9_]{1,40}$/, `${JSON.stringify(hostile)} -> ${token}`)
    assert.ok(!token.includes('/') && !token.includes('\\') && !token.includes('.'))
  }
  // Too long is rejected rather than truncated into something ambiguous.
  assert.match(safeIdToken('x'.repeat(80), 's'), /^[0-9a-f]{8}$/)
})

test('makeId, slugify and cardFileName are git-friendly', () => {
  const id = makeId(Date.parse('2026-10-13T02:00:00Z'), 'abcdef123456')
  assert.equal(id, 'kb-20261013-abcdef12')
  assert.equal(slugify('DSH 插件 / 第二大脑：设计'), 'DSH-插件-第二大脑-设计')
  assert.equal(slugify('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
  assert.equal(slugify('（测试）《报告》'), '测试-报告')
  assert.equal(slugify(''), 'card')
  assert.equal(Array.from(slugify('长'.repeat(200))).length, 48)
  const name = cardFileName({ id: 'kb-20261013-abcdef', title: '第二大脑 设计', createdAt: Date.parse('2026-10-13T02:00:00Z') })
  assert.equal(name, '2026-10-13-第二大脑-设计--abcdef.md')
  // The file name must never carry a path separator, whatever the id claims.
  const hostile = cardFileName({ id: '../../../owned', title: 'innocent', createdAt: Date.parse('2026-10-13T02:00:00Z') })
  assert.match(hostile, /^2026-10-13-innocent--[0-9a-f]{8}\.md$/)
  assert.ok(!hostile.includes('/') && !hostile.includes('..'))
})

test('card serialization round-trips through Markdown + YAML frontmatter', () => {
  const card = {
    id: 'kb-20261013-abcdef',
    title: '标题里有 "引号" 和\n换行',
    kind: 'decision',
    tags: ['dsh', '第二大脑'],
    links: ['kb-1', 'kb-2'],
    provenance: ['session-x#/tmp#turn3'],
    createdAt: Date.parse('2026-10-13T02:00:00Z'),
    updatedAt: Date.parse('2026-10-13T03:00:00Z'),
    hash: contentHash('body'),
    pinned: true,
    lang: 'ts',
  }
  const body = '# 正文\n\n```ts\nconst a = 1\n```\n'
  const text = serializeCard(card, body)
  assert.ok(text.startsWith('---\n'))
  const parsed = parseCard(text)
  assert.equal(parsed.ok, true, parsed.error)
  const back = normalizeCard(parsed.data, parsed.body, 'x.md')
  assert.equal(back.title, card.title)
  assert.deepEqual(back.tags, card.tags)
  assert.deepEqual(back.links, card.links)
  assert.deepEqual(back.provenance, card.provenance)
  assert.equal(back.kind, 'decision')
  assert.equal(back.pinned, true)
  assert.equal(back.lang, 'ts')
  assert.equal(back.createdAt, card.createdAt)
  assert.equal(parsed.body.trim(), body.trim())
})

test('parseCard rejects malformed frontmatter instead of guessing', () => {
  assert.equal(parseCard('no frontmatter here').ok, false)
  assert.equal(parseCard('---\ntitle: "x"\n---\n\nbody').ok, false, 'missing id')
  const orphan = parseCard('---\nid: a\ntitle: "x"\n- oops\n---\n')
  assert.equal(orphan.ok, false)
})

test('summarize strips code fences and clamps', () => {
  const text = '# 标题\n\n正文内容\n\n```js\nconst secret = 1\n```\n'
  const out = summarize(text, 40)
  assert.ok(out.startsWith('标题'))
  assert.ok(!out.includes('secret'))
  assert.equal(Array.from(summarize('测'.repeat(300), 10)).length, 11)
})

test('extractTags surfaces languages, extensions and hashtags first', () => {
  const text = '#设计 我们决定使用 TypeScript 重写。\n```ts\nconst a: number = 1\n```\n参见 lib/core.js'
  const tags = extractTags(text, { limit: 6 })
  assert.ok(tags.includes('ts'))
  assert.ok(tags.includes('js'))
  assert.ok(tags.includes('设计'))
})

test('BM25 search: exact CJK phrase beats a loose bag of words', () => {
  const cards = [
    { id: 'a', title: '知识图谱可视化', tags: ['图谱'], body: '用 SVG 绘制力导向图，支持图例过滤与框选。', kind: 'fact', createdAt: 3 },
    { id: 'b', title: '知识库目录结构', tags: ['图谱', '目录'], body: '知识卡放在 cards 目录下，每张卡一个 Markdown 文件。', kind: 'fact', createdAt: 2 },
    { id: 'c', title: '音乐播放器笔记', tags: ['音乐'], body: '与本文无关的内容，只是恰好出现了知识两个字。', kind: 'fact', createdAt: 1 },
  ]
  const index = buildSearchIndex(cards)
  const hits = searchIndex(index, '知识图谱', { limit: 3 })
  assert.equal(hits[0].id, 'a')
  assert.ok(hits.length >= 2)
  const none = searchIndex(index, '不存在的词', { limit: 3 })
  assert.equal(none.length, 0)
})

test('search filters by tag, kind and time window', () => {
  const cards = [
    { id: 'a', title: 'alpha', tags: ['t1'], body: 'shared keyword', kind: 'fact', createdAt: 1000 },
    { id: 'b', title: 'beta', tags: ['t2'], body: 'shared keyword', kind: 'snippet', createdAt: 2000 },
  ]
  const index = buildSearchIndex(cards)
  assert.deepEqual(searchIndex(index, 'shared', { filters: { tag: 't2' } }).map((h) => h.id), ['b'])
  assert.deepEqual(searchIndex(index, 'shared', { filters: { kind: 'snippet' } }).map((h) => h.id), ['b'])
  assert.deepEqual(searchIndex(index, 'shared', { filters: { since: 1500 } }).map((h) => h.id), ['b'])
  assert.equal(searchIndex(index, 'shared', { filters: { until: 500 } }).length, 0)
})

test('matchesInOrder and snippet', () => {
  assert.equal(matchesInOrder(['a', 'b', 'c'], ['b', 'c']), true)
  assert.equal(matchesInOrder(['a', 'b', 'c'], ['c', 'b']), false)
  assert.equal(snippet('短', 'x'), '短')
  const long = `${'前'.repeat(200)}目标关键词${'后'.repeat(200)}`
  const out = snippet(long, '目标关键词', 40)
  assert.ok(out.includes('目标关键词'))
  assert.ok(out.startsWith('…'))
})

test('buildGraph produces link edges, capped tag edges and a tag legend', () => {
  const cards = [
    { id: 'a', title: 'A', tags: ['x', 'y'], links: ['b'], body: 'aaa', createdAt: 3 },
    { id: 'b', title: 'B', tags: ['x'], links: [], body: 'bbb', createdAt: 2 },
    { id: 'c', title: 'C', tags: ['x'], links: [], body: 'ccc', createdAt: 1 },
  ]
  const graph = buildGraph(cards)
  assert.equal(graph.nodes.length, 3)
  // a→b is both an explicit link and a shared-tag pair, so the two signals fold
  // into one edge whose weight sums and whose labels accumulate.
  const link = graph.edges.find((edge) => edge.source === 'a' && edge.target === 'b')
  assert.ok(link !== undefined)
  assert.equal(link.type, 'link')
  assert.equal(link.weight, 4)
  assert.deepEqual(link.labels.sort(), ['link', 'x'])
  assert.ok(graph.edges.some((edge) => edge.type === 'tag' && edge.labels.includes('x')))
  assert.deepEqual(graph.tags.map((tag) => tag.name).sort(), ['x', 'y'])
  assert.ok(graph.nodes.every((node) => typeof node.degree === 'number'))
  // A tag above the membership cap must not generate edges.
  const wide = buildGraph(
    Array.from({ length: 60 }, (_, index) => ({ id: `w${index}`, title: `W${index}`, tags: ['wide'], body: 'x' })),
    { tagEdgeLimit: 40 },
  )
  assert.equal(wide.edges.length, 0)
})

test('mergeCards unions metadata, concatenates distinct bodies and keeps the earliest date', () => {
  const cards = [
    { id: 'a', title: 'A', kind: 'fact', tags: ['t1'], links: ['b', 'z'], provenance: ['p1'], body: '共用正文', createdAt: 10 },
    { id: 'b', title: 'B', kind: 'fact', tags: ['t1', 't2'], links: ['a'], provenance: ['p2'], body: '共用正文', createdAt: 20 },
    { id: 'c', title: 'C', kind: 'fact', tags: ['t3'], links: [], provenance: [], body: '另一段正文', createdAt: 30 },
  ]
  const { card, body } = mergeCards(cards, { title: '合并结果', now: 100 })
  assert.equal(card.title, '合并结果')
  assert.equal(card.id, 'a')
  assert.equal(card.createdAt, 10)
  assert.equal(card.updatedAt, 100)
  assert.deepEqual(card.tags, ['t1', 't2', 't3'])
  assert.deepEqual(card.links, ['z'])
  assert.deepEqual(card.provenance, ['p1', 'p2'])
  assert.ok(body.includes('共用正文'))
  assert.ok(body.includes('另一段正文'))
  assert.ok(card.hash.length > 0)
})

test('mergeCards labels each section with the card it actually came from', () => {
  // The first card has an EMPTY body, so index 0 of the filtered block list is
  // card B, not card A. Pairing by index into the unfiltered list would label
  // B's section with A's title.
  const cards = [
    { id: 'a', title: '甲', kind: 'fact', tags: [], links: [], provenance: [], body: '', createdAt: 10 },
    { id: 'b', title: '乙', kind: 'fact', tags: [], links: [], provenance: [], body: '乙的正文', createdAt: 20 },
    { id: 'c', title: '丙', kind: 'fact', tags: [], links: [], provenance: [], body: '丙的正文', createdAt: 30 },
  ]
  const { body } = mergeCards(cards, { now: 100 })
  assert.ok(body.includes('## 1. 乙'), body)
  assert.ok(body.includes('## 2. 丙'), body)
  assert.ok(!body.includes('## 1. 甲'))
  assert.ok(body.indexOf('乙的正文') < body.indexOf('丙的正文'), 'sections keep chronological order')

  // Exact duplicate bodies collapse to a single section, and a lone body is
  // emitted without any heading at all.
  const dupes = mergeCards([
    { id: 'x', title: '一', kind: 'fact', tags: [], links: [], provenance: [], body: '同一段正文', createdAt: 1 },
    { id: 'y', title: '二', kind: 'fact', tags: [], links: [], provenance: [], body: '同一段正文', createdAt: 2 },
  ], { now: 5 })
  assert.equal(dupes.body, '同一段正文')
  assert.ok(!dupes.body.includes('## '))
})

test('export/import bundle round-trips and validates bad input', () => {
  const entries = [
    {
      card: { id: 'kb-1', title: '导出测试', kind: 'fact', tags: ['a'], links: [], provenance: ['p'], createdAt: 5, updatedAt: 6, hash: contentHash('正文'), pinned: false, lang: '' },
      body: '正文',
    },
  ]
  const bundle = exportBundle(entries, 1000)
  assert.equal(bundle.format, 'dsh-second-brain')
  assert.equal(bundle.count, 1)
  const { entries: back, errors } = importBundle(JSON.parse(JSON.stringify(bundle)))
  assert.deepEqual(errors, [])
  assert.equal(back.length, 1)
  assert.equal(back[0].card.title, '导出测试')
  assert.deepEqual(back[0].card.tags, ['a'])
  assert.equal(back[0].body, '正文')

  const bad = importBundle({ format: 'other', cards: [{ body: 'no title' }] })
  assert.equal(bad.entries.length, 0)
  assert.ok(bad.errors.length >= 2)
  assert.deepEqual(importBundle(null).entries, [])
})
