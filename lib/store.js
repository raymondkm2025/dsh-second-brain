/**
 * dsh-second-brain store: the on-disk knowledge vault.
 *
 * The vault is deliberately boring so it stays git-friendly: one Markdown file
 * per card under `cards/`, YAML frontmatter for metadata, and nothing else. No
 * database, no index file by default, no lock files, no binary blobs. A user can
 * `git init`, `git log -p`, hand-edit a card in any editor, and the plugin will
 * pick the change up on the next read because every card is re-validated against
 * its mtime.
 *
 * All file IO goes through `node:fs` rather than `ctx.fs` on purpose: the host
 * `ctx.fs` service fences writes under the session's workspace policy, which
 * would silently drop a card whenever the vault lives outside the workspace
 * (which is the default). This mirrors how the shipped music plugin persists its
 * own state.
 */

import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { homedir } from 'node:os'

import {
  buildGraph,
  buildSearchIndex,
  cardFileName,
  compareCards,
  contentHash,
  exactSimilarityOfSets,
  exportBundle,
  importBundle,
  makeId,
  mergeCards,
  minhash,
  normalizeCard,
  parseCard,
  searchIndex,
  serializeCard,
  snippet,
  slugify,
  summarize,
  tokenSet,
} from './core.js'

/**
 * Bodies longer than this are compared with MinHash only. Beyond a few thousand
 * characters a card is a document, not a note, and caching its token set for
 * every comparison costs more than the extra precision is worth.
 */
const MAX_TOKENIZED_CHARS = 20000

/**
 * Resolve the DSH home directory the same way the shipped plugins do:
 * `DSH_HOME` when the host set it, otherwise `~/.dsh`.
 * @returns {string}
 */
export function resolveDshHome() {
  const fromEnv = typeof process !== 'undefined' && process.env ? process.env.DSH_HOME : undefined
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * The plugin's state directory inside the DSH home.
 * @returns {string}
 */
export function stateDir() {
  return join(resolveDshHome(), 'second-brain')
}

/**
 * Default vault location, overridable by config or by the settings page.
 * @returns {string}
 */
export function defaultVaultRoot() {
  const fromEnv = typeof process !== 'undefined' && process.env ? process.env.DSH_SECOND_BRAIN_VAULT : undefined
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return expandHome(fromEnv.trim())
  return join(stateDir(), 'vault')
}

/**
 * Expand a leading `~` into the user's home directory.
 * @param {string} input
 * @returns {string}
 */
export function expandHome(input) {
  const text = String(input ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Turn a user-supplied path into an absolute one, expanding `~` and resolving
 * relative paths against the DSH home (a stable anchor, unlike the session cwd).
 * @param {string} input
 * @returns {string}
 */
export function resolveVaultPath(input) {
  const expanded = expandHome(input)
  if (expanded === '') return defaultVaultRoot()
  return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(join(resolveDshHome(), expanded))
}

/** @typedef {'off'|'heuristic'|'llm'} CaptureMode */

/**
 * Default configuration. Kept as a plain object (not a schema) so the plugin
 * needs no dependency on the host's schema library, and so a hand-edited
 * `config.json` is always accepted field by field.
 * @returns {object}
 */
export function defaultConfig() {
  return {
    vault: defaultVaultRoot(),
    capture: /** @type {CaptureMode} */ ('heuristic'),
    minChars: 400,
    maxCardChars: 6000,
    minCodeLines: 3,
    minCodeChars: 100,
    tagsLimit: 6,
    dedupeThreshold: 0.42,
    relatedThreshold: 0.18,
    autoMergeDuplicates: true,
    linkRelated: true,
    gitAutoCommit: false,
    writeIndexFile: false,
    // Model used by capture: 'llm'. Empty = inherit the session's own route.
    llmProvider: '',
    llmModel: '',
  }
}

/**
 * Coerce an untrusted config object onto the defaults, dropping unknown or
 * wrong-typed fields rather than failing to start.
 * @param {unknown} raw
 * @returns {object}
 */
export function sanitizeConfig(raw) {
  const base = defaultConfig()
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw
  const text = (key) => (typeof input[key] === 'string' ? input[key] : base[key])
  const num = (key, min, max) => {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return base[key]
    return Math.min(max, Math.max(min, value))
  }
  const bool = (key) => (typeof input[key] === 'boolean' ? input[key] : base[key])
  const mode = ['off', 'heuristic', 'llm'].includes(String(input.capture)) ? String(input.capture) : base.capture
  return {
    vault: input.vault === undefined ? base.vault : resolveVaultPath(String(input.vault)),
    capture: mode,
    minChars: num('minChars', 0, 100000),
    maxCardChars: num('maxCardChars', 200, 200000),
    minCodeLines: num('minCodeLines', 1, 50),
    minCodeChars: num('minCodeChars', 20, 5000),
    tagsLimit: num('tagsLimit', 1, 20),
    dedupeThreshold: num('dedupeThreshold', 0.15, 0.999),
    relatedThreshold: num('relatedThreshold', 0.05, 0.9),
    autoMergeDuplicates: bool('autoMergeDuplicates'),
    linkRelated: bool('linkRelated'),
    gitAutoCommit: bool('gitAutoCommit'),
    writeIndexFile: bool('writeIndexFile'),
    llmProvider: text('llmProvider'),
    llmModel: text('llmModel'),
  }
}

/**
 * Resolve a card file name under the vault's `cards/` directory, refusing
 * anything that escapes it.
 *
 * `cardFileName()` already reduces the id to a safe token, so this is a second,
 * independent line of defence: even if a future caller hands `write()` an
 * arbitrary string, no code path can create or delete a file outside the vault.
 * @param {string} cardsDir
 * @param {string} file
 * @returns {string} the absolute path
 * @throws {Error} when the resolved path leaves the cards directory.
 */
export function resolveCardPath(cardsDir, file) {
  const base = resolvePath(cardsDir)
  const full = resolvePath(base, String(file ?? ''))
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`拒绝写入知识库目录之外的路径: ${String(file)}`)
  }
  return full
}

/**
 * Write a file atomically (temp file in the same directory, then rename) so a
 * crash mid-write can never truncate a knowledge card.
 * @param {string} file
 * @param {string} text
 */
export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* best effort */
    }
    throw error
  }
}

/**
 * Run `git` in a directory.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function runGit(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({
        ok: error === null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (error === null ? '' : String(error.message ?? error)),
      })
    })
  })
}

/**
 * The knowledge vault: card files plus every derived view the host and the
 * settings page need (list, search index, graph).
 */
export class Vault {
  /**
   * @param {{ root: string, logger?: { warn: (...args: unknown[]) => void, info?: (...args: unknown[]) => void } }} options
   */
  constructor(options) {
    this.root = options.root
    this.logger = options.logger ?? null
    /** @type {Map<string, {mtimeMs: number, size: number, card: object, sig: Uint32Array, tokens: Set<string>|null}>} */
    this.entries = new Map()
    /** @type {object[]} */
    this.cards = []
    /** @type {Map<string, object>} */
    this.byId = new Map()
    this.dirty = true
    /** @type {ReturnType<typeof buildSearchIndex> | null} */
    this.searchCache = null
    this.scannedAt = 0
  }

  /** @returns {string} the `cards/` directory. */
  get cardsDir() {
    return join(this.root, 'cards')
  }

  /**
   * Create the vault skeleton. Idempotent.
   * @returns {void}
   */
  ensure() {
    mkdirSync(this.cardsDir, { recursive: true })
  }

  /**
   * Re-scan the vault. Only files whose mtime or size moved are re-parsed, so a
   * large vault stays cheap to refresh on every request.
   * @param {{ force?: boolean }} [options]
   * @returns {void}
   */
  scan(options = {}) {
    const force = options.force === true
    this.ensure()
    const seen = new Set()
    let files = []
    try {
      files = readdirSync(this.cardsDir).filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    } catch (error) {
      this.warn(`无法读取知识库目录 ${this.cardsDir}: ${describeError(error)}`)
      files = []
    }
    for (const name of files) {
      const file = join(this.cardsDir, name)
      let stats
      try {
        stats = statSync(file)
      } catch {
        continue
      }
      if (!stats.isFile()) continue
      seen.add(name)
      const cached = this.entries.get(name)
      if (!force && cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) continue
      try {
        const text = readFileSync(file, 'utf8')
        const parsed = parseCard(text)
        if (!parsed.ok) {
          this.warn(`跳过无法解析的知识卡 ${name}: ${parsed.error}`)
          this.entries.delete(name)
          continue
        }
        const card = normalizeCard(parsed.data, parsed.body, name)
        if (card.id === '') card.id = makeId(card.createdAt, contentHash(`${card.title}\n${card.body}`))
        const plain = `${card.title}\n${card.body}`
        this.entries.set(name, {
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          card,
          sig: minhash(plain).sig,
          tokens: card.body.length > MAX_TOKENIZED_CHARS ? null : new Set(tokenSet(plain)),
        })
      } catch (error) {
        this.warn(`读取知识卡失败 ${name}: ${describeError(error)}`)
      }
    }
    for (const name of [...this.entries.keys()]) if (!seen.has(name)) this.entries.delete(name)

    this.cards = [...this.entries.values()].map((entry) => entry.card).sort((left, right) => right.createdAt - left.createdAt)
    this.byId = new Map()
    for (const card of this.cards) this.byId.set(card.id, card)
    this.searchCache = null
    this.dirty = false
    this.scannedAt = Date.now()
  }

  /**
   * Refresh when needed.
   * @param {{ force?: boolean }} [options]
   * @returns {void}
   */
  touch(options = {}) {
    if (this.dirty || options.force === true) this.scan(options)
  }

  /** @returns {object[]} every card, newest first. */
  list() {
    this.touch()
    return this.cards
  }

  /**
   * @param {string} id
   * @returns {object | undefined}
   */
  get(id) {
    this.touch()
    return this.byId.get(String(id ?? ''))
  }

  /**
   * The mtime cache entry for a card, which carries its MinHash signature.
   * @param {string} id
   * @returns {{card: object, sig: Uint32Array} | undefined}
   */
  entryOf(id) {
    this.touch()
    const card = this.byId.get(String(id ?? ''))
    if (card === undefined) return undefined
    return this.entries.get(card.file)
  }

  /**
   * The BM25 index, rebuilt lazily whenever the card set changed.
   * @returns {ReturnType<typeof buildSearchIndex>}
   */
  index() {
    this.touch()
    if (this.searchCache === null) this.searchCache = buildSearchIndex(this.cards)
    return this.searchCache
  }

  /**
   * Ranked search.
   * @param {string} query
   * @param {{ limit?: number, filters?: object, withSnippet?: boolean }} [options]
   * @returns {Array<object>}
   */
  search(query, options = {}) {
    const limit = options.limit ?? 20
    const hits = searchIndex(this.index(), query, { limit, filters: options.filters })
    return hits.map((hit) => {
      const card = this.byId.get(hit.id)
      return {
        ...summarizeCard(card),
        score: Number(hit.score.toFixed(4)),
        matched: hit.matched,
        snippet: options.withSnippet === false ? '' : snippet(card?.body ?? '', query),
      }
    })
  }

  /**
   * Find cards close enough to a candidate to matter.
   *
   * Two stages, because dedupe runs on every capture and the vault grows:
   *   1. A MinHash prefilter rejects the overwhelming majority of cards with a
   *      256-slot signature comparison — no tokenization, no allocation.
   *   2. Survivors are compared exactly over cached token sets, which is cheap
   *      for the handful that get through and gives a trustworthy verdict.
   *
   * @param {{title: string, body: string, hash: string, sig?: Uint32Array, tokens?: Set<string>}} candidate
   * @param {{ threshold?: number, relatedThreshold?: number, containmentThreshold?: number, prefilter?: number }} [options]
   * @returns {{ matches: Array<object>, duplicates: Array<object>, related: Array<object> }}
   */
  findSimilar(candidate, options = {}) {
    const threshold = options.threshold ?? 0.42
    const relatedThreshold = options.relatedThreshold ?? 0.18
    const containmentThreshold = options.containmentThreshold ?? 0.85
    const prefilter = options.prefilter ?? 0.08
    this.touch()
    const title = String(candidate.title ?? '')
    const body = String(candidate.body ?? '')
    const text = `${title}\n${body}`
    const sig = candidate.sig ?? minhash(text).sig
    const tokens = candidate.tokens ?? new Set(tokenSet(text.slice(0, MAX_TOKENIZED_CHARS)))
    const matches = []
    for (const card of this.cards) {
      const entry = this.entries.get(card.file)
      if (entry === undefined) continue
      if (card.hash !== '' && card.hash === candidate.hash) {
        matches.push({ card, verdict: 'exact', similarity: 1, containment: 1, basis: 'hash' })
        continue
      }
      if (entry.sig.size > 0 && jaccardEstimate(entry.sig, sig) < prefilter) continue
      const exact = entry.tokens === null
        ? { jaccard: jaccardEstimate(entry.sig, sig), containment: 0 }
        : exactSimilarityOfSets(entry.tokens, tokens)
      let verdict = 'distinct'
      if (exact.jaccard >= threshold) verdict = 'duplicate'
      else if (exact.containment >= containmentThreshold && exact.jaccard >= threshold * 0.55) verdict = 'duplicate'
      else if (exact.jaccard >= relatedThreshold) verdict = 'related'
      if (verdict === 'distinct') continue
      matches.push({ card, verdict, similarity: exact.jaccard, containment: exact.containment, basis: 'exact' })
    }
    matches.sort((left, right) => right.similarity - left.similarity || right.containment - left.containment)
    return {
      matches,
      duplicates: matches.filter((match) => match.verdict === 'exact' || match.verdict === 'duplicate'),
      related: matches.filter((match) => match.verdict === 'related'),
    }
  }

  /**
   * Persist a card, creating its file when needed. Returns the file name.
   * @param {object} card
   * @param {string} body
   * @param {{ reassignOnCollision?: boolean }} [options] set false for a caller
   *   that is intentionally EDITING the card holding this id (title and body may
   *   both change); leave true for a caller creating a new card, where a taken id
   *   means a hash collision rather than an edit.
   * @returns {string}
   */
  write(card, body, options = {}) {
    const reassignOnCollision = options.reassignOnCollision !== false
    this.ensure()
    let id = card.id
    let existing = this.byId.get(id)
    // A colliding id must never silently replace an unrelated card. If the id is
    // taken by a different card, mint a fresh id instead of reusing its file.
    if (reassignOnCollision && existing !== undefined && existing.hash !== card.hash && existing.title !== card.title) {
      id = makeId(card.createdAt ?? Date.now(), `${card.hash}${Math.random()}`)
      card = { ...card, id }
      existing = undefined
    }
    const file = existing !== undefined && existing.file !== '' ? existing.file : cardFileName(card)
    const target = resolveCardPath(this.cardsDir, file)
    const record = {
      ...card,
      id,
      file,
      body: String(body ?? ''),
      updatedAt: card.updatedAt ?? Date.now(),
    }
    const text = serializeCard(record, record.body)
    writeFileAtomic(target, text)
    const stats = statSync(target)
    const plain = `${record.title}\n${record.body}`
    this.entries.set(file, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      card: record,
      sig: minhash(plain).sig,
      tokens: record.body.length > MAX_TOKENIZED_CHARS ? null : new Set(tokenSet(plain)),
    })
    this.dirty = true
    return file
  }

  /**
   * @param {string[]} ids
   * @returns {{ deleted: string[] }}
   */
  remove(ids) {
    this.touch()
    const deleted = []
    for (const id of ids ?? []) {
      const card = this.byId.get(String(id))
      if (card === undefined) continue
      try {
        rmSync(resolveCardPath(this.cardsDir, card.file), { force: true })
        this.entries.delete(card.file)
        deleted.push(card.id)
      } catch (error) {
        this.warn(`删除知识卡失败 ${card.id}: ${describeError(error)}`)
      }
    }
    this.dirty = true
    return { deleted }
  }

  /**
   * Merge several cards into one, deleting the absorbed files.
   * @param {string[]} ids
   * @param {{ title?: string }} [options]
   * @returns {{ card: object, removed: string[] }}
   */
  merge(ids, options = {}) {
    this.touch()
    const cards = []
    for (const id of ids ?? []) {
      const card = this.byId.get(String(id))
      if (card !== undefined) cards.push(card)
    }
    if (cards.length < 2) throw new Error('合并至少需要两张知识卡')
    const { card, body } = mergeCards(cards, { title: options.title })
    this.ensure()
    const primary = this.byId.get(card.id)
    // Keep the surviving card's file when the title did not move, so a merge
    // whose title is unchanged stays a pure content edit in git.
    const reuse = primary !== undefined && primary.file !== '' && primary.title === card.title
    const file = reuse ? primary.file : cardFileName(card)
    const record = { ...card, file }
    writeFileAtomic(resolveCardPath(this.cardsDir, file), serializeCard(record, body))
    const removed = []
    for (const item of cards) {
      if (item.id === card.id) continue
      try {
        rmSync(resolveCardPath(this.cardsDir, item.file), { force: true })
        this.entries.delete(item.file)
        removed.push(item.id)
      } catch (error) {
        this.warn(`合并后删除 ${item.id} 失败: ${describeError(error)}`)
      }
    }
    // The surviving card's file moved (its title changed), so retire the old
    // name only after the content is safely written under the new one.
    if (!reuse && primary !== undefined && primary.file !== '' && primary.file !== file) {
      try {
        rmSync(resolveCardPath(this.cardsDir, primary.file), { force: true })
        this.entries.delete(primary.file)
      } catch (error) {
        this.warn(`合并后清理旧文件失败 ${primary.file}: ${describeError(error)}`)
      }
    }
    const stats = statSync(resolveCardPath(this.cardsDir, file))
    const plain = `${record.title}\n${body}`
    this.entries.set(file, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      card: record,
      sig: minhash(plain).sig,
      tokens: body.length > MAX_TOKENIZED_CHARS ? null : new Set(tokenSet(plain)),
    })
    this.dirty = true
    return { card: record, removed }
  }

  /**
   * The graph model for the settings page.
   * @returns {ReturnType<typeof buildGraph>}
   */
  graph() {
    this.touch()
    return buildGraph(this.cards)
  }

  /**
   * @returns {object} a JSON export bundle of the whole vault.
   */
  exportAll() {
    this.touch()
    const entries = this.cards.map((card) => ({ card, body: card.body ?? '' }))
    return exportBundle(entries)
  }

  /**
   * Import a bundle. `mode: 'merge'` keeps existing cards and skips exact
   * duplicates; `mode: 'replace'` empties the vault first.
   * @param {unknown} bundle
   * @param {{ mode?: 'merge'|'replace', dedupe?: boolean }} [options]
   * @returns {{ imported: number, skipped: number, errors: string[] }}
   */
  importAll(bundle, options = {}) {
    const mode = options.mode ?? 'merge'
    const dedupe = options.dedupe !== false
    this.touch()

    // Parse and validate FIRST. The previous order wiped the vault and only then
    // discovered the bundle was unusable, so a single malformed (or empty)
    // request destroyed every card and still answered `ok: true`.
    const { entries, errors } = importBundle(bundle)
    if (mode === 'replace') {
      if (entries.length === 0) {
        return { imported: 0, skipped: 0, errors: [...errors, '拒绝以空 bundle 执行 replace：知识库未被清空'] }
      }
      for (const card of [...this.cards]) {
        try {
          rmSync(resolveCardPath(this.cardsDir, card.file), { force: true })
        } catch (error) {
          this.warn(`清空知识库失败 ${card.id}: ${describeError(error)}`)
        }
      }
      this.entries.clear()
      this.dirty = true
      this.touch()
    }
    let imported = 0
    let skipped = 0
    const usedIds = new Set(this.cards.map((card) => card.id))

    // Dedupe against a local fingerprint table instead of calling
    // `findSimilar()` per card: that would `touch()` the vault after every write
    // and re-read every file, turning an n-card import into O(n²) filesystem
    // work — enough to hang on a few thousand cards.
    const known = dedupe
      ? this.cards.map((card) => {
          const entry = this.entries.get(card.file)
          return {
            hash: card.hash,
            sig: entry === undefined ? minhash(`${card.title}\n${card.body}`).sig : entry.sig,
            tokens: entry === undefined ? null : entry.tokens,
          }
        })
      : []

    for (const entry of entries) {
      const card = { ...entry.card }
      if (usedIds.has(card.id)) {
        // Keep imported ids stable but never let two cards collide.
        card.id = makeId(card.createdAt, `${card.hash}${imported}${skipped}`)
      }
      if (dedupe) {
        // `importBundle` carries the body beside the card, not inside it.
        const body = String(entry.body ?? '')
        const text = `${card.title}\n${body}`
        const sig = minhash(text).sig
        const tokens = body.length > MAX_TOKENIZED_CHARS ? null : new Set(tokenSet(text))
        const duplicate = known.some((item) => {
          if (item.hash !== '' && item.hash === card.hash) return true
          if (item.sig.size > 0 && jaccardEstimate(item.sig, sig) < 0.08) return false
          if (item.tokens === null || tokens === null) return false
          const exact = exactSimilarityOfSets(item.tokens, tokens)
          return exact.jaccard >= 0.42 || (exact.containment >= 0.85 && exact.jaccard >= 0.42 * 0.55)
        })
        if (duplicate) {
          skipped++
          continue
        }
        known.push({ hash: card.hash, sig, tokens })
      }
      usedIds.add(card.id)
      this.write(card, entry.body)
      imported++
    }
    this.dirty = true
    this.touch({ force: true })
    return { imported, skipped, errors }
  }

  /**
   * @returns {{ cards: number, tags: number, bytes: number, links: number, latest: number, vault: string }}
   */
  stats() {
    this.touch()
    const tags = new Set()
    let bytes = 0
    let links = 0
    let latest = 0
    for (const card of this.cards) {
      for (const tag of card.tags) tags.add(tag)
      bytes += (card.body ?? '').length
      links += (card.links ?? []).length
      if (card.updatedAt > latest) latest = card.updatedAt
    }
    return { cards: this.cards.length, tags: tags.size, bytes, links, latest, vault: this.root }
  }

  /**
   * Write the optional generated `index.json`. Off by default so a git repo
   * holds only hand-authored Markdown.
   * @returns {string} the file written.
   */
  writeIndexFile() {
    this.touch()
    const file = join(this.root, 'index.json')
    const payload = {
      format: 'dsh-second-brain-index',
      version: 1,
      generatedAt: new Date().toISOString(),
      cards: this.cards.map((card) => ({ ...summarizeCard(card), file: card.file, links: card.links ?? [], provenance: card.provenance ?? [] })),
      tags: this.graph().tags,
    }
    writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`)
    return file
  }

  /**
   * Initialise a git repository in the vault (plus a `.gitignore` for the
   * optional generated index) and make the first commit.
   * @returns {Promise<{ok: boolean, output: string}>}
   */
  async gitInit() {
    this.ensure()
    const ignore = join(this.root, '.gitignore')
    if (!existsSync(ignore)) writeFileAtomic(ignore, 'index.json\n*.tmp\n')
    const init = await runGit(this.root, ['init'])
    if (!init.ok) return { ok: false, output: init.stderr || 'git init 失败' }
    const add = await runGit(this.root, ['add', '-A'])
    if (!add.ok) return { ok: false, output: `git add 失败：${add.stderr}` }
    const commit = await runGit(this.root, ['commit', '-m', 'chore(second-brain): 初始化知识库'])
    // An initial commit legitimately fails when the repository is already
    // populated and clean; anything else is a real failure the UI must surface
    // instead of claiming success.
    const output = `${init.stdout}${add.stdout}${commit.stdout}${commit.stderr}`.trim()
    if (!commit.ok && !/nothing to commit|no changes added/i.test(commit.stderr + commit.stdout)) {
      return { ok: false, output: output || 'git commit 失败' }
    }
    return { ok: true, output }
  }

  /**
   * Stage and commit current changes.
   * @param {string} [message]
   * @returns {Promise<{ok: boolean, output: string}>}
   */
  async gitCommit(message) {
    const status = await runGit(this.root, ['status', '--porcelain'])
    if (!status.ok) return { ok: false, output: status.stderr || '不是 git 仓库（可先执行 gitInit）' }
    if (status.stdout.trim() === '') return { ok: true, output: '没有需要提交的变更' }
    await runGit(this.root, ['add', '-A'])
    const commit = await runGit(this.root, ['commit', '-m', message ?? `chore(second-brain): 更新知识库 ${new Date().toISOString()}`])
    return { ok: commit.ok, output: `${commit.stdout}${commit.stderr}`.trim() }
  }

  /**
   * @param {string} message
   */
  warn(message) {
    if (this.logger !== null && typeof this.logger.warn === 'function') this.logger.warn(message)
  }
}

/**
 * Public (list/graph) projection of a card: everything except the full body.
 * @param {object} card
 * @returns {object}
 */
export function summarizeCard(card) {
  if (card === undefined || card === null) return {}
  return {
    id: card.id,
    title: card.title,
    kind: card.kind ?? 'fact',
    tags: card.tags ?? [],
    links: card.links ?? [],
    provenance: card.provenance ?? [],
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    pinned: card.pinned === true,
    lang: card.lang ?? '',
    file: card.file ?? '',
    summary: summarize(card.body ?? '', 180),
    chars: (card.body ?? '').length,
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

export { slugify }
