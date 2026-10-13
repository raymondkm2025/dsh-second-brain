import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { contentHash, minhash } from '../lib/core.js'
import {
  Vault,
  defaultConfig,
  resolveCardPath,
  resolveVaultPath,
  sanitizeConfig,
  summarizeCard,
} from '../lib/store.js'

/** Workspace-local temp root: the session sandbox permits writes here. */
const TEMP_ROOT = join(process.cwd(), '.test-tmp')

/**
 * @param {string} name
 * @returns {string}
 */
function makeVaultDir(name) {
  mkdirSync(TEMP_ROOT, { recursive: true })
  return mkdtempSync(join(TEMP_ROOT, `${name}-`))
}

/**
 * @param {object} overrides
 * @returns {object}
 */
function card(overrides) {
  const body = overrides.body ?? '正文'
  return {
    id: overrides.id ?? `kb-${Math.random().toString(36).slice(2, 10)}`,
    title: overrides.title ?? '标题',
    kind: overrides.kind ?? 'fact',
    tags: overrides.tags ?? [],
    links: overrides.links ?? [],
    provenance: overrides.provenance ?? [],
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    hash: contentHash(`${overrides.title ?? '标题'}\n${body}`),
    pinned: false,
    lang: '',
    ...overrides,
    body,
  }
}

test('sanitizeConfig clamps, coerces and drops garbage', () => {
  const config = sanitizeConfig({
    vault: '~/kb',
    capture: 'nonsense',
    minChars: -5,
    tagsLimit: 999,
    dedupeThreshold: 2,
    gitAutoCommit: 'yes',
    unknownField: 1,
  })
  assert.equal(config.capture, 'heuristic', 'an unknown mode falls back')
  assert.equal(config.minChars, 0, 'numbers are clamped, not rejected')
  assert.equal(config.tagsLimit, 20)
  assert.equal(config.dedupeThreshold, 0.999)
  assert.equal(config.gitAutoCommit, false, 'non-boolean falls back to the default')
  assert.equal('unknownField' in config, false)
  assert.ok(config.vault.endsWith('/kb'))
  assert.deepEqual(sanitizeConfig(null), defaultConfig())
})

test('resolveVaultPath expands ~ and resolves relative paths against DSH home', () => {
  const home = process.env.DSH_HOME ?? ''
  assert.equal(resolveVaultPath('~/kb').endsWith('/kb'), true)
  assert.equal(resolveVaultPath('kb'), join(home, 'kb'))
  assert.equal(resolveVaultPath('/abs/kb'), '/abs/kb')
})

test('vault writes, scans and reads back Markdown cards', () => {
  const root = makeVaultDir('crud')
  try {
    const vault = new Vault({ root })
    vault.write(card({ id: 'kb-a', title: '第一张', body: '这是正文', tags: ['t1'] }), '这是正文')
    const files = readdirSync(join(root, 'cards'))
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}-第一张--a\.md$/)

    // A fresh instance must see the same content purely from disk.
    const reopened = new Vault({ root })
    const listed = reopened.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].title, '第一张')
    assert.equal(listed[0].body, '这是正文')
    assert.deepEqual(listed[0].tags, ['t1'])
    assert.equal(reopened.get('kb-a').id, 'kb-a')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault re-reads only files whose mtime/size moved', () => {
  const root = makeVaultDir('cache')
  try {
    const vault = new Vault({ root })
    const first = card({ id: 'kb-x', title: '缓存', body: 'v1' })
    vault.write(first, 'v1')
    const scanCountAfterWrite = vault.entries.size
    assert.equal(scanCountAfterWrite, 1)
    // Edit the file behind the vault's back (the "user edited it in vim" path).
    const file = join(root, 'cards', readdirSync(join(root, 'cards'))[0])
    writeFileSync(file, readFileSync(file, 'utf8').replace('v1', 'v2'), 'utf8')
    vault.dirty = true
    vault.scan()
    assert.equal(vault.get('kb-x').body.includes('v2'), true, 'an external edit is picked up')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault unparseable files are skipped, not fatal', () => {
  const root = makeVaultDir('bad')
  try {
    const vault = new Vault({ root })
    vault.ensure()
    writeFileSync(join(root, 'cards', 'broken.md'), 'no frontmatter at all', 'utf8')
    vault.scan()
    assert.equal(vault.list().length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findSimilar: exact hash wins, containment promotes to duplicate, far cards do not match', () => {
  const root = makeVaultDir('similar')
  try {
    const vault = new Vault({ root })
    const base = 'DSH 插件需要 package.json 与 cordis.patch.yml 两个文件，缺一不可。'
    vault.write(card({ id: 'kb-1', title: '插件结构', body: base }), base)

    const same = vault.findSimilar({ title: '插件结构', body: base, hash: contentHash(`插件结构\n${base}`) })
    assert.equal(same.duplicates[0].verdict, 'exact')
    assert.equal(same.duplicates[0].similarity, 1)

    const longer = `${base}另外还要在 profile 里启用 bundle。`
    const contained = vault.findSimilar({ title: '插件结构（补充）', body: longer, hash: contentHash(`x\n${longer}`) })
    assert.ok(contained.duplicates.length >= 1, 'containment promotes a superset to a duplicate')
    assert.equal(contained.duplicates[0].containment, 1)

    const far = '桂林山水甲天下，阳朔山水甲桂林。'
    const distant = vault.findSimilar({ title: '旅游', body: far, hash: contentHash(`旅游\n${far}`) })
    assert.deepEqual(distant.matches, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault search, graph, merge, export/import and delete', () => {
  const root = makeVaultDir('ops')
  try {
    const vault = new Vault({ root })
    const a = '用 SVG 绘制力导向图，支持图例过滤、时间维与框选。'
    const b = '知识卡以 Markdown 存储，frontmatter 保存标签与来源。'
    const c = '力导向图需要斥力与弹簧迭代，节点按标签着色。'
    vault.write(card({ id: 'kb-a', title: '图谱可视化', body: a, tags: ['图谱', 'svg'] }), a)
    vault.write(card({ id: 'kb-b', title: '卡片格式', body: b, tags: ['存储'] }), b)
    vault.write(card({ id: 'kb-c', title: '力导向布局', body: c, tags: ['图谱'] }), c)

    const hits = vault.search('力导向图', { limit: 5 })
    assert.ok(hits.length >= 2)
    assert.ok(hits[0].snippet.length > 0)
    assert.ok(['kb-a', 'kb-c'].includes(hits[0].id), 'the two force-layout cards outrank the storage card')
    // A phrase that exists in exactly one card must bring that card to the top.
    const phrase = vault.search('图例过滤', { limit: 5 })
    assert.equal(phrase[0].id, 'kb-a')
    assert.ok(phrase[0].snippet.includes('图例过滤'))

    const graph = vault.graph()
    assert.equal(graph.nodes.length, 3)
    assert.ok(graph.edges.some((edge) => edge.type === 'tag' && edge.labels.includes('图谱')))
    assert.deepEqual(graph.tags.map((tag) => tag.name).sort(), ['svg', '图谱', '存储'])

    const stats = vault.stats()
    assert.equal(stats.cards, 3)
    assert.equal(stats.tags, 3)

    const merged = vault.merge(['kb-a', 'kb-c'], { title: '图谱可视化（合并）' })
    assert.equal(merged.card.title, '图谱可视化（合并）')
    // Only the absorbed card is reported: the primary card survives, under a new
    // file name because its title moved.
    assert.deepEqual(merged.removed, ['kb-c'])
    assert.equal(vault.list().length, 2)
    assert.equal(readdirSync(join(root, 'cards')).length, 2, 'the renamed survivor does not leave a stray file')
    assert.match(merged.card.file, /^2026-10-13-图谱可视化-合并--a\.md$/)
    assert.ok(merged.card.tags.includes('svg'))
    assert.ok(merged.card.tags.includes('图谱'))

    const bundle = vault.exportAll()
    assert.equal(bundle.count, 2)

    const otherRoot = makeVaultDir('ops-import')
    try {
      const target = new Vault({ root: otherRoot })
      const imported = target.importAll(JSON.parse(JSON.stringify(bundle)))
      assert.equal(imported.imported, 2)
      assert.equal(target.list().length, 2)
      // Importing the same bundle again is a no-op thanks to dedupe.
      const again = target.importAll(JSON.parse(JSON.stringify(bundle)))
      assert.equal(again.imported, 0)
      assert.equal(again.skipped, 2)
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }

    const deleted = vault.remove(vault.list().map((item) => item.id))
    assert.equal(deleted.deleted.length, 2)
    assert.equal(vault.list().length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vault import with mode=replace clears first, and rejects junk safely', () => {
  const root = makeVaultDir('replace')
  try {
    const vault = new Vault({ root })
    vault.write(card({ id: 'kb-old', title: '旧卡', body: '旧内容' }), '旧内容')
    assert.equal(vault.list().length, 1)

    const result = vault.importAll(
      { format: 'dsh-second-brain', version: 1, cards: [{ title: '新卡', body: '新内容', createdAt: new Date().toISOString() }] },
      { mode: 'replace' },
    )
    assert.equal(result.imported, 1)
    assert.equal(vault.list().length, 1)
    assert.equal(vault.list()[0].title, '新卡')

    const junk = vault.importAll({ cards: 'nope' })
    assert.equal(junk.imported, 0)
    assert.ok(junk.errors.length >= 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('import dedupes inside the bundle and scales without re-reading the vault', () => {
  const root = makeVaultDir('import-scale')
  try {
    const vault = new Vault({ root })
    const now = Date.now()
    // 300 distinct cards plus one exact repeat of the first — the repeat must be
    // skipped, and the whole import must not degrade to O(n^2) filesystem work.
    // Bodies must be genuinely distinct: a templated body differing only by a
    // number IS a near-duplicate and would (correctly) be folded into the first.
    const WORDS = Array.from({ length: 60 }, (_, index) => String.fromCharCode(0x4e00 + index * 37))
    const seed = (index) => {
      let state = index + 1
      return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        return state / 0x7fffffff
      }
    }
    const cards = Array.from({ length: 300 }, (_, index) => {
      const rand = seed(index)
      const words = Array.from({ length: 12 }, () => WORDS[Math.floor(rand() * WORDS.length)])
      return {
        title: `条目 ${index}`,
        body: `${words.join('')}。唯一标识 ${index.toString(36)}${(index * 2654435761 % 4294967296).toString(36)}。`,
        createdAt: new Date(now - index * 1000).toISOString(),
      }
    })
    cards.push({ title: '条目 0', body: cards[0].body, createdAt: cards[0].createdAt })

    const started = Date.now()
    const result = vault.importAll({ format: 'dsh-second-brain', version: 1, cards }, { mode: 'replace' })
    const elapsed = Date.now() - started
    assert.deepEqual(result.errors, [])
    assert.equal(result.imported, 300)
    assert.equal(result.skipped, 1, 'the in-bundle duplicate is caught')
    assert.equal(vault.list().length, 300)
    assert.ok(elapsed < 10000, `importing 300 cards took ${elapsed}ms`)
    // Ids must stay unique across the whole batch.
    assert.equal(new Set(vault.list().map((card) => card.id)).size, 300)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveCardPath refuses to leave the cards directory', () => {
  const dir = join(process.cwd(), 'vault', 'cards')
  // Legitimate names resolve normally.
  assert.equal(resolveCardPath(dir, '2026-10-13-x--abc.md'), join(dir, '2026-10-13-x--abc.md'))
  assert.equal(resolveCardPath(dir, 'nested/ok.md'), join(dir, 'nested/ok.md'))
  // Anything that escapes is rejected, not silently clamped.
  for (const escape of ['../owned.md', '../../../../pwned.md', 'a/../../b.md', '/etc/passwd']) {
    assert.throws(() => resolveCardPath(dir, escape), /拒绝写入知识库目录之外/, escape)
  }
})

test('write mints a fresh id instead of overwriting a card on an id collision', () => {
  const root = makeVaultDir('collide')
  try {
    const vault = new Vault({ root })
    const first = card({ id: 'kb-20261013-deadbeef', title: '原始卡', body: '原始正文' })
    vault.write(first, first.body)
    assert.equal(vault.list().length, 1)

    // A DIFFERENT card that happens to hash to the same id: creating it must not
    // replace the original.
    const impostor = card({ id: 'kb-20261013-deadbeef', title: '撞号卡', body: '完全不同的正文' })
    vault.write(impostor, impostor.body)
    const titles = vault.list().map((item) => item.title).sort()
    assert.deepEqual(titles, ['原始卡', '撞号卡'].sort(), 'both cards survive')
    assert.equal(readdirSync(join(root, 'cards')).length, 2)
    assert.equal(vault.get('kb-20261013-deadbeef').title, '原始卡', 'the original keeps its id')

    // An intentional EDIT of the same card (same id, new title and body) must
    // update in place rather than spawn a second card.
    const edited = card({ id: 'kb-20261013-deadbeef', title: '原始卡（改）', body: '改写后的正文' })
    vault.write(edited, edited.body, { reassignOnCollision: false })
    assert.equal(vault.list().length, 2)
    assert.equal(vault.get('kb-20261013-deadbeef').title, '原始卡（改）')
    assert.equal(readdirSync(join(root, 'cards')).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('summarizeCard is the public projection and never leaks the body', () => {
  const summary = summarizeCard(card({ id: 'kb-z', title: '投影', body: '很长的正文'.repeat(80), tags: ['a'] }))
  assert.equal(summary.id, 'kb-z')
  assert.equal('body' in summary, false)
  assert.ok(summary.summary.length <= 181)
  assert.deepEqual(summarizeCard(undefined), {})
})

test('vault git integration initialises a repo and commits changes', async (t) => {
  const root = makeVaultDir('git')
  try {
    const vault = new Vault({ root })
    vault.write(card({ id: 'kb-g', title: 'git 测试', body: '内容' }), '内容')
    const init = await vault.gitInit()
    if (!init.ok) {
      t.skip(`git unavailable in this environment: ${init.output}`)
      return
    }
    assert.ok(init.ok)
    // A second commit with no changes reports "nothing to commit", not an error.
    const clean = await vault.gitCommit('noop')
    assert.equal(clean.ok, true)
    assert.match(clean.output, /没有需要提交的变更/)
    vault.write(card({ id: 'kb-g', title: 'git 测试', body: '内容已更新', createdAt: Date.now() }), '内容已更新')
    const committed = await vault.gitCommit('update')
    assert.equal(committed.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeIndexFile emits a JSON snapshot when the user opts in', () => {
  const root = makeVaultDir('index')
  try {
    const vault = new Vault({ root })
    vault.write(card({ id: 'kb-i', title: '索引', body: '正文', tags: ['t'] }), '正文')
    const file = vault.writeIndexFile()
    const payload = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(payload.format, 'dsh-second-brain-index')
    assert.equal(payload.cards.length, 1)
    assert.equal(payload.tags[0].name, 't')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MINHASH signatures stay stable across processes (dedupe after restart)', () => {
  const text = '本地 Markdown 知识卡使用 YAML frontmatter。'
  const first = minhash(text).sig
  const second = minhash(text).sig
  assert.deepEqual([...first], [...second])
})
