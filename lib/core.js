/**
 * dsh-second-brain core: pure, dependency-free logic shared by the host half,
 * the browser half and the test suite.
 *
 * Everything in this file is deterministic and side-effect free — no node
 * builtins, no DOM. That is deliberate: the browser bundle must stay
 * self-contained (the client ModuleLoader can only resolve platform seeds and
 * registered packages, never a relative file), so the client half keeps its own
 * copy of the few helpers it needs, while the host half and the tests import
 * this module directly.
 *
 * Four responsibilities:
 *   1. Tokenization that works for CJK as well as for latin text (character
 *      bigrams for CJK runs, word tokens for latin/digit/hangul runs). This is
 *      what makes retrieval work without any external segmenter.
 *   2. Near-duplicate detection: an exact content hash plus a MinHash signature
 *      compared with a Jaccard estimate.
 *   3. Retrieval: a BM25 index over the tokenizer, with a phrase-proximity bonus
 *      so an exact substring match always outranks a loose bag-of-words match.
 *   4. The knowledge-card codec (Markdown + YAML frontmatter) and the graph
 *      model (nodes, edges, tag legend).
 */

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

/**
 * 64-bit-ish content hash as 16 hex chars. Two independent 32-bit FNV-1a style
 * lanes, mixed — plenty for duplicate detection, and dependency-free so the
 * browser half can compute the same value.
 * @param {string} input
 * @returns {string}
 */
export function hash64(input) {
  const text = String(input ?? '')
  let h1 = 0x811c9dc5
  let h2 = 0xcbf29ce4
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
    h2 = (h2 ^ (h2 >>> 13)) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/**
 * Normalize for exact-duplicate comparison: lowercase, unify line endings,
 * strip markdown emphasis/backticks, collapse whitespace, drop trailing
 * punctuation. Two cards whose bodies normalize to the same string are the
 * same knowledge.
 * @param {string} input
 * @returns {string}
 */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .replace(/[.,;:!?。，、；：！？…·]+$/g, '')
}

/**
 * Exact-duplicate key: the normalized content hash plus its length, so two
 * different texts colliding in the 64-bit space stay distinguishable.
 * @param {string} input
 * @returns {string}
 */
export function contentHash(input) {
  const normalized = normalizeText(input)
  return `${hash64(normalized)}-${normalized.length}`
}

/* ------------------------------------------------------------------ *
 * Tokenization
 * ------------------------------------------------------------------ */

const LATIN_RE = /[a-z0-9_]/
/** Joiners that stay inside a latin token only when flanked by word chars. */
const JOINERS = new Set([45, 46, 47, 95, 43, 35])

/**
 * @param {number} c
 * @returns {boolean} whether the code unit is a latin/digit/hangul word char.
 */
function isWordCode(c) {
  if (c >= 97 && c <= 122) return true
  if (c >= 48 && c <= 57) return true
  if (c === 95) return true
  if (c >= 0xac00 && c <= 0xd7a3) return true
  if (c >= 0x3131 && c <= 0x318e) return true
  return false
}

/**
 * @param {number} c
 * @returns {boolean} whether the code unit is a Han or kana character.
 */
export function isCjkCode(c) {
  if (c >= 0x3040 && c <= 0x30ff) return true
  if (c >= 0x3400 && c <= 0x4dbf) return true
  if (c >= 0x4e00 && c <= 0x9fff) return true
  if (c >= 0xf900 && c <= 0xfaff) return true
  if (c >= 0x2e80 && c <= 0x2eff) return true
  return false
}

/**
 * @param {string} input
 * @returns {boolean} whether the text contains any CJK character.
 */
export function hasCjk(input) {
  const text = String(input ?? '')
  for (let i = 0; i < text.length; i++) if (isCjkCode(text.charCodeAt(i))) return true
  return false
}

/**
 * Tokenize into an ordered token stream.
 *
 * - CJK runs of one character emit that character; longer runs emit every
 *   adjacent character bigram, plus the whole run when it is short (<= 4), which
 *   makes short titles and names retrievable as a single unit.
 * - Latin/digit/hangul runs emit a word token, keeping internal joiners
 *   (`.`/`/`/`-`/`_`/`+`/`#`) so identifiers such as `ctx.webServer` or
 *   `lib/core.js` stay intact for exact matching.
 *
 * Order is preserved so callers can score phrase adjacency.
 * @param {string} input
 * @param {{ keepStopwords?: boolean }} [options]
 * @returns {string[]}
 */
export function tokenize(input, options = {}) {
  const text = String(input ?? '').toLowerCase()
  const keep = options.keepStopwords === true
  const tokens = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text.charCodeAt(i)
    if (isCjkCode(c)) {
      let j = i
      let run = ''
      while (j < n && isCjkCode(text.charCodeAt(j))) {
        run += text[j]
        j++
      }
      const chars = Array.from(run)
      if (chars.length === 1) tokens.push(chars[0])
      else {
        for (let k = 0; k + 1 < chars.length; k++) tokens.push(chars[k] + chars[k + 1])
        if (chars.length <= 4) tokens.push(run)
      }
      i = j
      continue
    }
    if (isWordCode(c)) {
      let j = i
      let word = ''
      while (j < n) {
        const cj = text.charCodeAt(j)
        if (isWordCode(cj)) {
          word += text[j]
          j++
          continue
        }
        if (JOINERS.has(cj) && word.length > 0 && j + 1 < n && isWordCode(text.charCodeAt(j + 1))) {
          word += text[j]
          j++
          continue
        }
        break
      }
      i = j
      const cleaned = word.replace(/^[._+#/-]+|[._+#/-]+$/g, '')
      if (cleaned !== '' && (keep || !isStopword(cleaned))) {
        tokens.push(cleaned)
        // An identifier such as `ctx.webServer.save` must be retrievable both as
        // a whole (exact match) and by its parts (a query for "save" should hit
        // it). Emit the segments too — but only for genuinely compound tokens,
        // so ordinary words do not inflate the stream.
        if (cleaned.length >= 8 && /[./]/.test(cleaned)) {
          for (const part of cleaned.split(/[./]+/)) {
            if (part.length >= 3 && part !== cleaned && !(keep ? false : isStopword(part))) tokens.push(part)
          }
        }
      }
      continue
    }
    i++
  }
  return tokens.filter(Boolean)
}

/** Small latin stopword set — only used for tag extraction and query pruning. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'then',
  'there', 'these', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your', 'not',
  'can', 'do', 'does', 'so', 'we', 'our', 'us', 'they', 'them', 'he', 'she', 'his', 'her',
  'i', 'me', 'my', 'no', 'yes', 'up', 'out', 'all', 'any', 'each', 'more', 'most', 'such',
])

/**
 * @param {string} token
 * @returns {boolean}
 */
export function isStopword(token) {
  return STOPWORDS.has(token)
}

/**
 * Tokenize and deduplicate, preserving first-seen order.
 * @param {string} input
 * @param {{ keepStopwords?: boolean }} [options]
 * @returns {string[]}
 */
export function tokenSet(input, options) {
  return [...new Set(tokenize(input, options))]
}

/* ------------------------------------------------------------------ *
 * Near-duplicate detection (MinHash over token shingles)
 * ------------------------------------------------------------------ */

/**
 * Number of MinHash permutations. 256 keeps the estimator's standard error near
 * 0.06, which is tight enough to use as a *prefilter*: it cheaply rejects the
 * overwhelming majority of unrelated cards so the exact comparison only runs on
 * plausible candidates.
 */
export const MINHASH_SIZE = 256

/**
 * Deterministic 32-bit PRNG (mulberry32) so signatures are reproducible across
 * processes — a requirement for stable dedupe after a restart.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @type {{ a: Uint32Array, b: Uint32Array } | null} */
let permutations = null

/** Build (once) the fixed coefficient table used by every signature. */
function ensurePermutations() {
  if (permutations !== null) return permutations
  const rand = mulberry32(0x5eed1a7e)
  const a = new Uint32Array(MINHASH_SIZE)
  const b = new Uint32Array(MINHASH_SIZE)
  for (let i = 0; i < MINHASH_SIZE; i++) {
    a[i] = (Math.floor(rand() * 0xffffffff) | 1) >>> 0
    b[i] = Math.floor(rand() * 0xffffffff) >>> 0
  }
  permutations = { a, b }
  return permutations
}

/**
 * Build character/token shingles (k-grams over the token stream) for MinHash.
 * @param {string[]} tokens
 * @param {number} [k]
 * @returns {string[]}
 */
export function shingles(tokens, k = 3) {
  if (tokens.length === 0) return []
  if (tokens.length <= k) return [tokens.join('\u0001')]
  const out = new Array(tokens.length - k + 1)
  for (let i = 0; i + k <= tokens.length; i++) out[i] = tokens.slice(i, i + k).join('\u0001')
  return out
}

/**
 * MinHash signature of a text: the minimum hash of each permutation over the
 * text's shingles. Similar texts produce signatures that agree on most slots,
 * and the agreement rate estimates their Jaccard similarity.
 *
 * `k` defaults to 2 rather than 3: knowledge cards are short, so a 3-gram
 * signature is brittle — a single appended sentence can drop the estimate below
 * any useful duplicate threshold. Bigrams keep a genuinely edited restatement
 * close to its original while still separating unrelated cards.
 * @param {string} input
 * @param {number} [k]
 * @returns {{ sig: Uint32Array, size: number, tokens: number }}
 */
export function minhash(input, k = 2) {
  const tokens = tokenize(String(input ?? ''))
  const grams = shingles(tokens, k)
  const { a, b } = ensurePermutations()
  const sig = new Uint32Array(MINHASH_SIZE).fill(0xffffffff)
  if (grams.length === 0) return { sig, size: 0, tokens: tokens.length }
  for (const gram of grams) {
    const base = parseInt(hash64(gram).slice(0, 8), 16) >>> 0
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const h = (Math.imul(a[i], base) + b[i]) >>> 0
      if (h < sig[i]) sig[i] = h
    }
  }
  return { sig, size: grams.length, tokens: tokens.length }
}

/**
 * Estimate the Jaccard similarity of two MinHash signatures.
 * @param {Uint32Array | number[]} left
 * @param {Uint32Array | number[]} right
 * @returns {number} 0..1
 */
export function jaccardEstimate(left, right) {
  if (left === undefined || right === undefined) return 0
  const n = Math.min(left.length, right.length)
  if (n === 0) return 0
  let same = 0
  for (let i = 0; i < n; i++) if (left[i] === right[i]) same++
  return same / n
}

/**
 * Exact token-set comparison. This is the verdict stage of dedupe: MinHash is
 * only a prefilter, because a knowledge card is short enough that the exact
 * answer is cheap once the candidate list is small.
 * @param {string} left
 * @param {string} right
 * @returns {{ jaccard: number, containment: number, leftTokens: number, rightTokens: number }}
 */
export function exactSimilarity(left, right) {
  const a = new Set(tokenize(String(left ?? '')))
  const b = new Set(tokenize(String(right ?? '')))
  return exactSimilarityOfSets(a, b)
}

/**
 * Exact Jaccard/containment over two already-tokenized sets. The vault caches
 * one token set per card, so a dedupe pass never re-tokenizes the whole vault.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {{ jaccard: number, containment: number, leftTokens: number, rightTokens: number }}
 */
export function exactSimilarityOfSets(a, b) {
  if (a.size === 0 || b.size === 0) return { jaccard: 0, containment: 0, leftTokens: a.size, rightTokens: b.size }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const token of small) if (large.has(token)) shared++
  const union = a.size + b.size - shared
  return {
    jaccard: union === 0 ? 0 : shared / union,
    containment: shared / small.size,
    leftTokens: a.size,
    rightTokens: b.size,
  }
}

/**
 * Decide whether `candidate` duplicates `existing`, and how.
 *
 * When both sides carry their text, the decision uses the exact token-set
 * Jaccard; otherwise it falls back to the MinHash estimate. Containment is also
 * reported, because "the same knowledge plus one extra paragraph" produces a
 * mediocre Jaccard but near-total containment — and that is still a duplicate.
 *
 * @param {{hash?: string, sig?: Uint32Array|number[], text?: string}} existing
 * @param {{hash?: string, sig?: Uint32Array|number[], text?: string}} candidate
 * @param {{ threshold?: number, relatedThreshold?: number, containmentThreshold?: number }} [options]
 * @returns {{ verdict: 'exact'|'duplicate'|'related'|'distinct', similarity: number, containment: number, basis: 'hash'|'exact'|'minhash' }}
 */
export function compareCards(existing, candidate, options = {}) {
  // Defaults come from measuring real card pairs. Over CJK bigram tokens, two
  // cards about the SAME TOPIC but holding different knowledge score 0.03-0.12,
  // while the same knowledge re-expressed scores 0.29-0.57 and a near-verbatim
  // restatement scores 0.54-0.81. A 0.42 boundary therefore sits in the wide
  // empty band between "same topic" and "same knowledge", instead of the
  // arbitrary 0.78 that let obvious rewrites slip through.
  const threshold = options.threshold ?? 0.42
  const relatedThreshold = options.relatedThreshold ?? 0.18
  const containmentThreshold = options.containmentThreshold ?? 0.85
  // An empty hash means "this card never recorded one" (hand-written file), not
  // "these two are identical" — two such cards must not collapse into one.
  if (typeof existing.hash === 'string' && existing.hash !== ''
    && typeof candidate.hash === 'string' && candidate.hash !== ''
    && existing.hash === candidate.hash) {
    return { verdict: 'exact', similarity: 1, containment: 1, basis: 'hash' }
  }
  let similarity = 0
  let containment = 0
  let basis = 'minhash'
  if (typeof existing.text === 'string' && typeof candidate.text === 'string') {
    const exact = exactSimilarity(existing.text, candidate.text)
    similarity = exact.jaccard
    containment = exact.containment
    basis = 'exact'
  } else if (existing.sig !== undefined && candidate.sig !== undefined) {
    similarity = jaccardEstimate(existing.sig, candidate.sig)
    containment = similarity
  }
  if (similarity >= threshold) return { verdict: 'duplicate', similarity, containment, basis }
  if (containment >= containmentThreshold && similarity >= threshold * 0.55) {
    return { verdict: 'duplicate', similarity, containment, basis }
  }
  if (similarity >= relatedThreshold) return { verdict: 'related', similarity, containment, basis }
  return { verdict: 'distinct', similarity, containment, basis }
}

/* ------------------------------------------------------------------ *
 * Identifiers and slugs
 * ------------------------------------------------------------------ */

/**
 * @param {number|string|Date} value
 * @returns {string} `YYYY-MM-DD` in UTC.
 */
export function dateStamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  return date.toISOString().slice(0, 10)
}

/**
 * Card id: `kb-YYYYMMDD-<6 hex>`. Stable, sortable, and readable in a diff.
 * @param {number} createdAt epoch millis
 * @param {string} hash content hash
 * @returns {string}
 */
export function makeId(createdAt, hash) {
  const day = dateStamp(createdAt).replace(/-/g, '')
  // 8 hex chars (2^32) rather than 6: with 6, a busy single-day vault has a
  // double-digit chance of at least one collision, and a collision used to mean
  // silently replacing an unrelated card.
  const suffix = String(hash ?? hash64(String(createdAt))).replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, '0')
  return `kb-${day}-${suffix}`
}

/**
 * Filesystem-safe slug. CJK is preserved (readable filenames in a git repo)
 * while path separators, control characters and punctuation collapse to `-`.
 * @param {string} input
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugify(input, maxLength = 48) {
  const text = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#%&{}$!'@+=`~^\[\]();,.]/g, '-')
    // Full-width punctuation is legal on POSIX but breaks Windows checkouts and
    // makes shell completion awkward, so normalize it away with the ASCII set.
    .replace(/[，。、；：？！“”‘’（）《》【】·—…～]/g, '-')
    .replace(/[\s\u3000]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  const chars = Array.from(text)
  const cut = chars.length > maxLength ? chars.slice(0, maxLength).join('') : text
  return cut.replace(/-+$/g, '') || 'card'
}

/**
 * A file-name-safe token derived from a card id.
 *
 * The id is NOT trusted: an imported bundle supplies it, and the import route is
 * reachable over HTTP. Interpolating it raw allowed `id: "../../../owned"` to
 * place a Markdown file anywhere the host process can write. Only a strict
 * `[A-Za-z0-9_]` token is accepted; anything else falls back to a content hash,
 * so the result can never contain a path separator, a dot segment, or a
 * platform-special character.
 * @param {string} id
 * @param {string} seed extra material for the fallback hash
 * @returns {string}
 */
export function safeIdToken(id, seed = '') {
  const last = String(id ?? '').split('-').pop() ?? ''
  if (/^[A-Za-z0-9_]{1,40}$/.test(last)) return last
  return hash64(`${String(id ?? '')}\u0000${seed}`).slice(0, 8)
}

/**
 * Vault-relative file name for a card. The id suffix keeps names unique even
 * when two cards share a title; the date prefix keeps a plain `ls` chronological.
 * @param {{id: string, title: string, createdAt: number}} card
 * @returns {string}
 */
export function cardFileName(card) {
  const suffix = safeIdToken(card.id, card.title ?? '')
  return `${dateStamp(card.createdAt)}-${slugify(card.title)}--${suffix}.md`
}

/* ------------------------------------------------------------------ *
 * Markdown + YAML frontmatter codec
 * ------------------------------------------------------------------ */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Emit a YAML scalar. JSON strings are valid YAML double-quoted scalars, so
 * `JSON.stringify` handles every escaping case we can hit.
 * @param {unknown} value
 * @returns {string}
 */
function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (value === null || value === undefined) return '""'
  return JSON.stringify(String(value))
}

/**
 * Serialize a knowledge card to Markdown: YAML frontmatter plus the body.
 * The output is stable for unchanged input so git diffs stay minimal.
 * @param {object} card
 * @param {string} body
 * @returns {string}
 */
export function serializeCard(card, body) {
  const lines = ['---']
  lines.push(`id: ${yamlScalar(card.id)}`)
  lines.push(`title: ${yamlScalar(card.title)}`)
  lines.push(`kind: ${yamlScalar(card.kind ?? 'fact')}`)
  lines.push(`createdAt: ${yamlScalar(new Date(card.createdAt).toISOString())}`)
  lines.push(`updatedAt: ${yamlScalar(new Date(card.updatedAt ?? card.createdAt).toISOString())}`)
  lines.push(`hash: ${yamlScalar(card.hash ?? '')}`)
  if (card.pinned === true) lines.push('pinned: true')
  if (card.lang !== undefined && card.lang !== '') lines.push(`lang: ${yamlScalar(card.lang)}`)
  const tags = Array.isArray(card.tags) ? card.tags : []
  if (tags.length === 0) lines.push('tags: []')
  else {
    lines.push('tags:')
    for (const tag of tags) lines.push(`  - ${yamlScalar(tag)}`)
  }
  const provenance = Array.isArray(card.provenance) ? card.provenance : []
  if (provenance.length > 0) {
    lines.push('provenance:')
    for (const item of provenance) lines.push(`  - ${yamlScalar(item)}`)
  }
  const links = Array.isArray(card.links) ? card.links : []
  if (links.length > 0) {
    lines.push('links:')
    for (const link of links) lines.push(`  - ${yamlScalar(link)}`)
  }
  lines.push('---', '')
  const text = String(body ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  return `${lines.join('\n')}\n${text}\n`
}

/**
 * Parse the YAML subset this plugin emits. Deliberately strict and tiny: a
 * plugin must not grow a YAML parser, and rejecting unknown shapes loudly is
 * better than silently mis-reading a hand-edited file.
 * @param {string} source
 * @returns {{ data: Record<string, unknown>, body: string, ok: boolean, error?: string }}
 */
export function parseCard(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return { data: {}, body: text.trim(), ok: false, error: 'missing frontmatter' }
  const data = {}
  const lines = match[1].split('\n')
  let currentKey = null
  let currentList = null
  for (const raw of lines) {
    if (raw.trim() === '') continue
    const listItem = /^\s{2,}-\s?(.*)$/.exec(raw)
    if (listItem !== null) {
      if (currentList === null) return { data, body: text.slice(match[0].length).trim(), ok: false, error: `orphan list item under ${currentKey}` }
      currentList.push(parseScalar(listItem[1]))
      continue
    }
    const entry = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(raw)
    if (entry === null) return { data, body: text.slice(match[0].length).trim(), ok: false, error: `unparsable frontmatter line: ${raw}` }
    const [, key, rest] = entry
    currentKey = key
    if (rest === '') {
      currentList = []
      data[key] = currentList
      continue
    }
    currentList = null
    data[key] = parseScalar(rest)
  }
  for (const key of ['id', 'title']) {
    if (typeof data[key] !== 'string' || data[key] === '') {
      return { data, body: text.slice(match[0].length).trim(), ok: false, error: `missing required field ${key}` }
    }
  }
  return { data, body: text.slice(match[0].length).trim(), ok: true }
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (value === '[]') return []
  if (value.startsWith('"') || value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

/**
 * Normalize a parsed frontmatter record into a full card object with defaults.
 * @param {Record<string, unknown>} data
 * @param {string} body
 * @param {string} [file]
 * @returns {object}
 */
export function normalizeCard(data, body, file) {
  const createdAt = Date.parse(String(data.createdAt ?? '')) || Date.now()
  const updatedAt = Date.parse(String(data.updatedAt ?? '')) || createdAt
  return {
    id: String(data.id ?? ''),
    title: String(data.title ?? '未命名'),
    kind: String(data.kind ?? 'fact'),
    tags: Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [],
    links: Array.isArray(data.links) ? data.links.map(String).filter(Boolean) : [],
    provenance: Array.isArray(data.provenance) ? data.provenance.map(String).filter(Boolean) : [],
    createdAt,
    updatedAt,
    hash: String(data.hash ?? ''),
    pinned: data.pinned === true,
    lang: data.lang === undefined ? '' : String(data.lang),
    file: file ?? '',
    body: String(body ?? ''),
  }
}

/* ------------------------------------------------------------------ *
 * Summaries and tags
 * ------------------------------------------------------------------ */

/**
 * A one-line-ish summary for list views and graph tooltips.
 * @param {string} body
 * @param {number} [max]
 * @returns {string}
 */
export function summarize(body, max = 160) {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}…`
}

/** Code fence languages that are worth promoting to a tag. */
const LANG_TAGS = new Set([
  'js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'python', 'py', 'go', 'rust', 'java',
  'kotlin', 'swift', 'ruby', 'php', 'c', 'cpp', 'csharp', 'sql', 'bash', 'sh', 'zsh', 'shell',
  'powershell', 'yaml', 'yml', 'json', 'toml', 'ini', 'html', 'css', 'scss', 'xml', 'dockerfile',
])

/**
 * Extract human-facing tags for a card.
 *
 * Score combines term frequency with a modest length bonus (longer CJK:
 * bigrams/terms and longer latin words are more specific), then keeps the top
 * `limit`. Fenced-code languages and file-extension tokens are always included
 * because they make excellent filters, and explicit `#hashtags` win outright.
 * @param {string} text
 * @param {{ limit?: number, extra?: string[] }} [options]
 * @returns {string[]}
 */
export function extractTags(text, options = {}) {
  const limit = options.limit ?? 6
  const source = String(text ?? '')
  const counts = new Map()
  const bump = (token, weight) => {
    if (token === undefined || token === '') return
    counts.set(token, (counts.get(token) ?? 0) + weight)
  }

  for (const token of tokenize(source)) {
    if (isStopword(token)) continue
    if (/^[0-9]+$/.test(token)) continue
    const length = Array.from(token).length
    if (length === 1 && LATIN_RE.test(token)) continue
    const bonus = length >= 4 ? 1.5 : length >= 3 ? 1.2 : length >= 2 ? 1 : 0.7
    bump(token, bonus)
  }

  const explicit = new Set()
  for (const match of source.matchAll(/#([\p{L}\p{N}_-]{2,24})/gu)) explicit.add(String(match[1]).toLowerCase())
  for (const match of source.matchAll(/```([a-zA-Z0-9+#-]{1,16})/g)) {
    const lang = String(match[1]).toLowerCase()
    if (LANG_TAGS.has(lang)) explicit.add(lang)
  }
  for (const token of tokenize(source)) {
    if (/(^|\/)[a-z0-9_-]+\.(js|mjs|cjs|ts|tsx|jsx|json|md|py|go|rs|java|rb|php|sh|yml|yaml|toml|css|html|sql)$/.test(token)) {
      explicit.add(token.split('.').pop())
    }
  }

  const ranked = [...counts.entries()]
    .filter(([token]) => !explicit.has(token))
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([token]) => token)

  const out = []
  const seen = new Set()
  // Caller-supplied tags (a code fence's language, the parent card's title) are
  // the highest-signal filters available, so they outrank mined terms; explicit
  // hashtags still come first because the author asked for them by name.
  for (const tag of [...explicit, ...(options.extra ?? []).map((item) => String(item).toLowerCase().trim()), ...ranked]) {
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= limit) break
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Retrieval: BM25 over the CJK-aware tokenizer
 * ------------------------------------------------------------------ */

const BM25_K1 = 1.2
const BM25_B = 0.72

/**
 * Build an in-memory retrieval index over normalized card documents.
 * @param {Array<{id: string, title?: string, tags?: string[], body?: string, kind?: string, createdAt?: number}>} cards
 * @returns {{ docs: Array<object>, df: Map<string, number>, avgLen: number, n: number, byId: Map<string, object> }}
 */
export function buildSearchIndex(cards) {
  const docs = []
  const df = new Map()
  let totalLen = 0
  for (const card of cards) {
    const title = String(card.title ?? '')
    const tags = Array.isArray(card.tags) ? card.tags.join(' ') : ''
    const body = String(card.body ?? '')
    // Title and tags are repeated so they weigh more in the term frequency,
    // without needing a separate field-aware scoring path.
    const tokens = tokenize(`${title} ${title} ${tags} ${tags} ${body}`)
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    const doc = {
      id: card.id,
      title,
      tags: Array.isArray(card.tags) ? card.tags : [],
      kind: String(card.kind ?? 'fact'),
      createdAt: card.createdAt ?? 0,
      len: tokens.length,
      tf,
      tokens,
      normalized: normalizeText(`${title} ${tags} ${body}`),
      haystack: `${title} ${tags} ${body}`.toLowerCase(),
    }
    docs.push(doc)
    totalLen += tokens.length
  }
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  return { docs, df, avgLen: docs.length === 0 ? 1 : totalLen / docs.length, n: docs.length, byId }
}

/**
 * @param {number} df
 * @param {number} n
 * @returns {number} inverse document frequency
 */
function idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

/**
 * Rank documents against a query.
 *
 * BM25 over the tokenizer, then a multiplicative bonus when the whole query
 * appears as a literal substring (this is what rescues short CJK queries, where
 * bigram overlap alone is noisy) and a smaller bonus for in-order token
 * adjacency.
 * @param {ReturnType<typeof buildSearchIndex>} index
 * @param {string} query
 * @param {{ limit?: number, filters?: {tag?: string, kind?: string, since?: number, until?: number} }} [options]
 * @returns {Array<{id: string, score: number, matched: string[], doc: object}>}
 */
export function searchIndex(index, query, options = {}) {
  const limit = options.limit ?? 20
  const filters = options.filters ?? {}
  const raw = String(query ?? '').trim()
  if (raw === '') return []
  const queryTokens = tokenize(raw)
  const unique = [...new Set(queryTokens)].filter((token) => !isStopword(token))
  const effective = unique.length > 0 ? unique : [...new Set(queryTokens)]
  const normalizedQuery = normalizeText(raw)
  const results = []

  for (const doc of index.docs) {
    if (filters.tag !== undefined && !doc.tags.includes(filters.tag)) continue
    if (filters.kind !== undefined && doc.kind !== filters.kind) continue
    if (filters.since !== undefined && doc.createdAt < filters.since) continue
    if (filters.until !== undefined && doc.createdAt > filters.until) continue

    let score = 0
    const matched = []
    for (const token of effective) {
      const tf = doc.tf.get(token)
      if (tf === undefined) continue
      matched.push(token)
      const df = index.df.get(token) ?? 1
      const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / index.avgLen)))
      score += idf(df, index.n) * norm
    }
    if (score === 0) continue

    // Coverage: a document matching every query token is far more likely to be
    // the intended answer than one matching a single common token.
    const coverage = matched.length / effective.length
    score *= 0.35 + 0.65 * coverage

    if (normalizedQuery !== '' && doc.normalized.includes(normalizedQuery)) {
      const at = doc.normalized.indexOf(normalizedQuery)
      score *= at < 80 ? 3.2 : 2.1
    } else if (matchesInOrder(doc.tokens, queryTokens)) {
      score *= 1.35
    }
    results.push({ id: doc.id, score, matched, doc })
  }

  results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return results.slice(0, limit)
}

/**
 * @param {string[]} haystack
 * @param {string[]} needle
 * @returns {boolean} whether `needle` appears as a contiguous run in `haystack`.
 */
export function matchesInOrder(haystack, needle) {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let ok = true
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/**
 * Best matching text window around the query, for search-result snippets.
 * @param {string} text
 * @param {string} query
 * @param {number} [window]
 * @returns {string}
 */
export function snippet(text, query, window = 120) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (source === '') return ''
  const needle = String(query ?? '').trim()
  const index = needle === '' ? -1 : source.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return Array.from(source).slice(0, window).join('')
  const chars = Array.from(source)
  const before = Array.from(source.slice(0, index)).length
  const start = Math.max(0, before - Math.floor(window / 3))
  const slice = chars.slice(start, start + window).join('')
  return `${start > 0 ? '…' : ''}${slice}${start + window < chars.length ? '…' : ''}`
}

/* ------------------------------------------------------------------ *
 * Knowledge graph model
 * ------------------------------------------------------------------ */

/**
 * Build the graph model the client renders.
 *
 * Edges come from two sources: explicit `links` (declared by the model tool or
 * by a merge), and tag co-membership. Tag edges are only emitted for tags whose
 * membership stays under `tagEdgeLimit`, otherwise a common tag such as `dsh`
 * would produce a quadratic hairball.
 * @param {Array<object>} cards
 * @param {{ tagEdgeLimit?: number, maxTagEdges?: number }} [options]
 * @returns {{ nodes: Array<object>, edges: Array<object>, tags: Array<{name: string, count: number}> }}
 */
export function buildGraph(cards, options = {}) {
  const tagEdgeLimit = options.tagEdgeLimit ?? 40
  const maxTagEdges = options.maxTagEdges ?? 4000
  const byId = new Map(cards.map((card) => [card.id, card]))
  const nodes = cards.map((card) => ({
    id: card.id,
    title: card.title,
    kind: String(card.kind ?? 'fact'),
    tags: Array.isArray(card.tags) ? card.tags : [],
    createdAt: card.createdAt ?? 0,
    updatedAt: card.updatedAt ?? card.createdAt ?? 0,
    summary: summarize(card.body ?? '', 140),
    pinned: card.pinned === true,
    bodyLength: String(card.body ?? '').length,
  }))

  const edges = []
  const seenEdge = new Set()
  const pushEdge = (source, target, type, weight, label) => {
    if (source === target) return
    const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`
    if (seenEdge.has(key)) {
      const existing = edges.find((edge) => edge.key === key)
      if (existing !== undefined) {
        existing.weight += weight
        if (label !== undefined && !existing.labels.includes(label) && existing.labels.length < 4) existing.labels.push(label)
      }
      return
    }
    seenEdge.add(key)
    edges.push({
      key,
      source,
      target,
      type,
      weight,
      labels: label === undefined ? [] : [label],
    })
  }

  for (const card of cards) {
    for (const link of card.links ?? []) {
      if (byId.has(link)) pushEdge(card.id, link, 'link', 3, 'link')
    }
  }

  const byTag = new Map()
  for (const card of cards) {
    for (const tag of card.tags ?? []) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(card.id)
    }
  }
  let tagEdges = 0
  for (const [tag, members] of byTag) {
    if (members.length < 2 || members.length > tagEdgeLimit) continue
    for (let i = 0; i < members.length && tagEdges < maxTagEdges; i++) {
      for (let j = i + 1; j < members.length && tagEdges < maxTagEdges; j++) {
        pushEdge(members[i], members[j], 'tag', 1, tag)
        tagEdges++
      }
    }
  }

  const degree = new Map()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0

  const tags = [...byTag.entries()]
    .map(([name, members]) => ({ name, count: members.length }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))

  return { nodes, edges, tags }
}

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

/**
 * Merge several cards into one.
 *
 * Tags, links and provenance are unioned; bodies are concatenated under
 * per-source headings, skipping blocks that are already byte-identical (which
 * is exactly what a duplicate-heavy vault produces). The earliest `createdAt`
 * survives so the merged card keeps the knowledge's original place in time.
 * @param {Array<object>} cards
 * @param {{ title?: string, now?: number }} [options]
 * @returns {{ card: object, body: string }}
 */
export function mergeCards(cards, options = {}) {
  if (cards.length === 0) throw new Error('mergeCards: no cards')
  const now = options.now ?? Date.now()
  const sorted = [...cards].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
  const primary = sorted[0]
  const tags = []
  const links = new Set()
  const provenance = []
  const seenTag = new Set()
  for (const card of sorted) {
    for (const tag of card.tags ?? []) {
      if (seenTag.has(tag)) continue
      seenTag.add(tag)
      tags.push(tag)
    }
    for (const link of card.links ?? []) links.add(link)
    for (const item of card.provenance ?? []) if (!provenance.includes(item)) provenance.push(item)
  }
  const mergedIds = new Set(sorted.map((card) => card.id))
  for (const id of mergedIds) links.delete(id)

  // Keep the body paired with the card it came from. Indexing a filtered list
  // against the unfiltered one would label a section with the wrong title as
  // soon as any card was skipped (empty body, or an exact repeat).
  const blocks = []
  const seenBlock = new Set()
  for (const card of sorted) {
    const body = String(card.body ?? '').trim()
    if (body === '') continue
    const key = normalizeText(body)
    if (seenBlock.has(key)) continue
    seenBlock.add(key)
    blocks.push({ title: card.title, body })
  }

  const title = options.title ?? primary.title
  const body = blocks
    .map((block, index) => (blocks.length === 1
      ? block.body
      : `## ${index + 1}. ${block.title ?? `片段 ${index + 1}`}\n\n${block.body}`))
    .join('\n\n')

  const card = {
    id: primary.id,
    title,
    kind: primary.kind ?? 'fact',
    tags,
    links: [...links],
    provenance,
    createdAt: primary.createdAt ?? now,
    updatedAt: now,
    hash: '',
    pinned: sorted.some((item) => item.pinned === true),
    lang: primary.lang ?? '',
  }
  card.hash = contentHash(`${title}\n${body}`)
  return { card, body }
}

/* ------------------------------------------------------------------ *
 * Import / export bundle
 * ------------------------------------------------------------------ */

/** Bundle format version, bumped when the shape changes incompatibly. */
export const BUNDLE_VERSION = 1

/**
 * @param {Array<{card: object, body: string}>} entries
 * @param {number} [now]
 * @returns {object} a JSON-serializable export bundle.
 */
export function exportBundle(entries, now = Date.now()) {
  return {
    format: 'dsh-second-brain',
    version: BUNDLE_VERSION,
    exportedAt: new Date(now).toISOString(),
    count: entries.length,
    cards: entries.map(({ card, body }) => ({
      id: card.id,
      title: card.title,
      kind: card.kind ?? 'fact',
      tags: card.tags ?? [],
      links: card.links ?? [],
      provenance: card.provenance ?? [],
      createdAt: new Date(card.createdAt ?? now).toISOString(),
      updatedAt: new Date(card.updatedAt ?? card.createdAt ?? now).toISOString(),
      pinned: card.pinned === true,
      lang: card.lang ?? '',
      body,
    })),
  }
}

/**
 * Validate an imported bundle and normalize it to `{card, body}` entries.
 * @param {unknown} input
 * @returns {{ entries: Array<{card: object, body: string}>, errors: string[] }}
 */
export function importBundle(input) {
  const errors = []
  const entries = []
  if (typeof input !== 'object' || input === null) return { entries, errors: ['bundle is not an object'] }
  const bundle = input
  if (bundle.format !== undefined && bundle.format !== 'dsh-second-brain') errors.push(`unknown format: ${String(bundle.format)}`)
  const cards = Array.isArray(bundle.cards) ? bundle.cards : []
  if (!Array.isArray(bundle.cards)) errors.push('bundle.cards is not an array')
  for (const raw of cards) {
    if (typeof raw !== 'object' || raw === null) {
      errors.push('skipped a non-object card')
      continue
    }
    const item = raw
    if (typeof item.title !== 'string' || item.title.trim() === '') {
      errors.push('skipped a card without a title')
      continue
    }
    const body = String(item.body ?? '')
    const createdAt = Date.parse(String(item.createdAt ?? '')) || Date.now()
    const card = {
      id: typeof item.id === 'string' && item.id !== '' ? item.id : makeId(createdAt, contentHash(`${item.title}\n${body}`)),
      title: item.title.trim(),
      kind: typeof item.kind === 'string' ? item.kind : 'fact',
      tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
      links: Array.isArray(item.links) ? item.links.map(String).filter(Boolean) : [],
      provenance: Array.isArray(item.provenance) ? item.provenance.map(String).filter(Boolean) : ['import'],
      createdAt,
      updatedAt: Date.parse(String(item.updatedAt ?? '')) || createdAt,
      hash: contentHash(`${item.title.trim()}\n${body}`),
      pinned: item.pinned === true,
      lang: typeof item.lang === 'string' ? item.lang : '',
    }
    entries.push({ card, body })
  }
  return { entries, errors }
}
