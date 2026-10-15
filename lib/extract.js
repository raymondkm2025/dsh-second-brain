/**
 * dsh-second-brain extraction: turn a finished conversation turn into zero or
 * more knowledge-card drafts.
 *
 * Deliberately heuristic and synchronous. Capturing knowledge must never make a
 * turn slower, must never fail a turn, and must work with no model configured —
 * so the default pipeline is a deterministic reading of the text the turn
 * actually produced, and the optional model-assisted path lives in the host
 * half behind an explicit config switch.
 *
 * What counts as "worth reusing" here:
 *   - the answer itself, when it is substantive and not conversational filler;
 *   - every non-trivial fenced code block, as its own snippet card (code is the
 *     most reused artefact of a coding session);
 *   - an explicit "remember this" request from the user.
 */

import { contentHash, extractTags, makeId, summarize, tokenize } from './core.js'

/** Markers that suggest the turn reached a decision rather than stated a fact. */
const DECISION_MARKERS = [
  '决定', '结论', '方案', '建议', '推荐', 'selected', 'decision', 'conclusion',
  'trade-off', 'tradeoff', 'we chose', 'we decided', 'root cause', '根因', '原因在于',
]

/** Markers that suggest a reproducible procedure. */
const PROCEDURE_MARKERS = [
  '步骤', '第一步', '首先', '然后', '接着', '最后', '命令', '运行', '安装', '配置',
  'step 1', 'first,', 'then ', 'run ', 'install ', 'configure ',
]

/** User phrasings that mean "store this on purpose". */
const REMEMBER_MARKERS = [
  '记住', '记下', '记录一下', '帮我记', '存入知识库', '存进知识库', '沉淀', '备忘',
  'remember this', 'note this', 'save this', 'keep in mind',
]

/**
 * @param {unknown} content a message content value: string, block array, or anything else.
 * @returns {string} the concatenated text blocks.
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const candidate = block
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n')
}

/**
 * Prefixes of harness-injected runtime context.
 *
 * DSH delivers its per-step runtime context ("Time sampled while preparing
 * turn…", "Current runtime context…") and its system reminders as ordinary
 * user-role messages. Treating one of those as "the user's request" produces a
 * knowledge card titled after a timestamp, so they must be recognised and
 * dropped. Matching is on the first line only, which is where every one of these
 * blocks puts its marker — a real request that merely *mentions* one of these
 * phrases further down still counts as a request.
 */
export const HARNESS_CONTEXT_MARKERS = [
  'current runtime context',
  'time sampled while preparing turn',
  'elapsed since the preceding',
  'you are an ai agent powered by',
  'you are interacting with the user through the deepseek harness web gui',
  'tokens prefixed with @ are paths',
  'agent teams is available in this session',
  'the browser provides no implicit dom',
]

/**
 * `message.source.kind` values that mean a human actually spoke.
 *
 * DSH delivers a great deal of machinery as `user`-ROLE messages — runtime
 * context, turn timing, model-change notices, teammate relays, subagent settle
 * notices — and every one of them carries a precise `source.kind`. Only `user`
 * is the human. Reading the envelope is exact; guessing from the text is not,
 * which is why an ever-growing marker list kept missing the next notice form
 * (`[model changed: …]` was the one that slipped through).
 *
 * @see HARNESS_CONTEXT_MARKERS for the text fallback when no envelope exists.
 */
export const HUMAN_SOURCE_KINDS = new Set(['user'])

/**
 * @param {unknown} message
 * @returns {string|null} `source.kind`, or null when the envelope carries none.
 */
function sourceKindOf(message) {
  const source = message.source
  if (typeof source !== 'object' || source === null) return null
  const kind = source.kind
  return typeof kind === 'string' && kind !== '' ? kind : null
}

/**
 * @param {string} text
 * @returns {boolean} whether the message is harness-injected context.
 */
export function isInjectedContext(text) {
  const source = String(text ?? '')
  const firstLine = source.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  const normalized = firstLine.replace(/^[#>*\-+\s]+/, '').toLowerCase()
  if (normalized === '') return false
  return HARNESS_CONTEXT_MARKERS.some((marker) => normalized.startsWith(marker))
}

/**
 * Flatten a session's derived messages into ordered `{role, text}` entries,
 * keeping only the two roles a knowledge card can come from and dropping the
 * harness's own injected context.
 * @param {ReadonlyArray<unknown>} messages
 * @param {{ keepInjected?: boolean }} [options]
 * @returns {Array<{role: 'user'|'assistant', text: string}>}
 */
export function flattenMessages(messages, options = {}) {
  const keepInjected = options.keepInjected === true
  const out = []
  for (const message of messages ?? []) {
    if (typeof message !== 'object' || message === null) continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = blocksToText(message.content).trim()
    if (text === '') continue
    if (role === 'user' && !keepInjected) {
      const kind = sourceKindOf(message)
      if (kind !== null) {
        // A real envelope is authoritative.
        if (!HUMAN_SOURCE_KINDS.has(kind)) continue
      } else if (isInjectedContext(text)) {
        // No envelope (seeded transcript, hand-built fixture): fall back to the
        // markers so those paths keep working.
        continue
      }
    }
    out.push({ role, text })
  }
  return out
}

/**
 * Slice the tail of a flattened transcript belonging to the most recent turn:
 * everything from the last user message onwards.
 * @param {Array<{role: string, text: string}>} flat
 * @returns {Array<{role: string, text: string}>}
 */
export function lastTurn(flat) {
  let start = -1
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i].role === 'user') {
      start = i
      break
    }
  }
  if (start < 0) return flat
  return flat.slice(start)
}

/** Fenced code block. Language is optional and captured as group 1. */
const CODE_FENCE_RE = /```([a-zA-Z0-9+#._-]*)[ \t]*\n([\s\S]*?)```/g

/**
 * Split a text into prose and fenced code blocks, in order.
 * @param {string} text
 * @returns {Array<{type: 'prose'|'code', text: string, lang?: string}>}
 */
export function splitBlocks(text) {
  const source = String(text ?? '')
  const out = []
  let cursor = 0
  CODE_FENCE_RE.lastIndex = 0
  let match = CODE_FENCE_RE.exec(source)
  while (match !== null) {
    if (match.index > cursor) {
      const prose = source.slice(cursor, match.index)
      if (prose.trim() !== '') out.push({ type: 'prose', text: prose })
    }
    out.push({ type: 'code', text: match[2].replace(/\s+$/, ''), lang: (match[1] || '').toLowerCase() })
    cursor = match.index + match[0].length
    match = CODE_FENCE_RE.exec(source)
  }
  if (cursor < source.length) {
    const prose = source.slice(cursor)
    if (prose.trim() !== '') out.push({ type: 'prose', text: prose })
  }
  return out
}

/**
 * Conversational filler detector.
 *
 * Three signals, in order of confidence: fenced code or a list always means
 * real content; a long text with a healthy unique-token count is real content;
 * anything short, repetitive, or matching a bare acknowledgement is not.
 * @param {string} text
 * @returns {boolean}
 */
export function isLowValue(text) {
  const source = String(text ?? '').trim()
  if (source === '') return true
  if (source.length > 800) return false
  if (source.includes('```')) return false
  if (/^[-*+]\s/m.test(source) || /^\d+[.)]\s/m.test(source)) return false
  const tokens = tokenize(source)
  const unique = new Set(tokens).size
  // "好的，明白了。" repeated twenty times is long but carries one idea.
  if (tokens.length > 28) return unique <= 10
  if (unique <= 3) return true
  // A bare acknowledgement, possibly in two clauses ("明白了，谢谢").
  const words = source.replace(/[，,。.!！~～\s、；;:：]+/g, ' ').trim().split(' ').filter(Boolean)
  return words.length > 0 && words.every((word) => ACKNOWLEDGEMENT_RE.test(word))
}

/**
 * A single acknowledgement word. Combined with the "every word matches" rule in
 * {@link isLowValue}, this catches "明白了，谢谢" without needing a phrase list.
 */
const ACKNOWLEDGEMENT_RE = /^(好[的呀吧]?|好的呢|ok|okay|嗯+|收到|明白[了]?|了解[了]?|是[的]?|对[的]?|谢谢|多谢|不客气|没问题|可以|行|sure|done|got it|yes|no|fine|thanks|thank you|yep|nope)$/i

/**
 * Derive a card title from the user's request.
 * @param {string} userText
 * @param {number} [max]
 * @returns {string}
 */
export function titleFromRequest(userText, max = 60) {
  let line = String(userText ?? '')
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item !== '') ?? ''
  line = line
    .replace(/^[#>*\-+\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (line === '') return '未命名知识卡'
  const chars = Array.from(line)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line
}

/**
 * @param {string} text
 * @param {string[]} markers
 * @returns {boolean}
 */
function containsAny(text, markers) {
  const lower = String(text ?? '').toLowerCase()
  return markers.some((marker) => lower.includes(marker))
}

/**
 * @param {{prose: string, codeBlocks: Array<{text: string, lang: string}>}} input
 * @returns {'snippet'|'procedure'|'decision'|'fact'}
 */
export function inferKind(input) {
  const codeChars = input.codeBlocks.reduce((total, block) => total + block.text.length, 0)
  const proseChars = Array.from(input.prose).length
  // "Snippet" means the card *is* the code. A card that merely contains code is
  // still a decision or a procedure, and labelling it "snippet" loses that.
  if (input.codeBlocks.length > 0 && proseChars < 120 && codeChars >= proseChars) return 'snippet'
  if (containsAny(input.prose, DECISION_MARKERS)) return 'decision'
  if (containsAny(input.prose, PROCEDURE_MARKERS)) return 'procedure'
  if (input.codeBlocks.length > 0 && codeChars >= proseChars * 2) return 'snippet'
  return 'fact'
}

/**
 * Assemble a card body from already-split segments, replacing each code block
 * with a one-line pointer to the snippet card it became.
 *
 * The pointer has to be inserted HERE, from the segment list. Running a
 * fence-stripping regex over prose that `splitBlocks()` already stripped can
 * never match — which is how the pointer silently went missing and the code
 * vanished from the prose card with no back-reference.
 * @param {Array<{type: string, text: string}>} segments
 * @returns {string}
 */
function joinProseWithPointers(segments) {
  const parts = []
  let pendingPointer = 0
  for (const segment of segments) {
    if (segment.type === 'code') {
      pendingPointer++
      continue
    }
    const text = segment.text.trim()
    if (text !== '') parts.push(text)
  }
  const prose = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  if (pendingPointer === 0) return prose
  const pointer = pendingPointer === 1
    ? '> 本轮的代码片段已单独存为知识卡。'
    : `> 本轮有 ${pendingPointer} 个代码片段已分别存为知识卡。`
  return prose === '' ? pointer : `${prose}\n\n${pointer}`
}

/**
 * Distill one finished turn into card drafts.
 * @param {object} input
 * @param {Array<{role: string, text: string}>} input.messages flattened turn messages
 * @param {string} [input.sessionId]
 * @param {string} [input.cwd]
 * @param {number} [input.turn]
 * @param {number} [input.now]
 * @param {object} [input.options]
 * @returns {{ drafts: Array<object>, reason: string }}
 */
export function distillTurn(input) {
  const options = input.options ?? {}
  const minChars = options.minChars ?? 400
  const maxCardChars = options.maxCardChars ?? 6000
  const maxTags = options.tagsLimit ?? 6
  const minCodeLines = options.minCodeLines ?? 3
  const minCodeChars = options.minCodeChars ?? 100
  const now = input.now ?? Date.now()
  const provenance = `${input.sessionId ?? 'session'}#${input.cwd ?? ''}#turn${input.turn ?? 0}`

  const messages = input.messages ?? []
  const userText = messages.filter((message) => message.role === 'user').map((message) => message.text).join('\n\n').trim()
  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  // Two different texts matter here, and conflating them was a bug:
  //   - the PROSE card comes from the turn's FINAL answer, because in a
  //     multi-step turn everything before it is process narration ("Let me…",
  //     "Now I'll…") that describes the work rather than the knowledge;
  //   - SNIPPET cards come from EVERY assistant message, because code written
  //     in step 3 is just as reusable as code written in the last step.
  const finalAnswer = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].text : ''
  const allAssistantText = assistantMessages.map((message) => message.text).join('\n\n').trim()
  const answerText = finalAnswer.trim() === '' ? allAssistantText : finalAnswer

  const drafts = []

  // Explicit "remember this" → keep the user's own words verbatim, even when
  // the assistant reply is short.
  if (containsAny(userText, REMEMBER_MARKERS) && userText.length >= 40) {
    const body = userText.slice(0, maxCardChars)
    const hash = contentHash(`${titleFromRequest(userText)}\n${body}`)
    drafts.push({
      id: makeId(now, hash),
      title: titleFromRequest(userText),
      kind: 'note',
      tags: extractTags(userText, { limit: maxTags, extra: ['note'] }),
      body,
      lang: '',
      provenance: [provenance],
      createdAt: now,
      updatedAt: now,
      hash,
    })
  }

  // The final answer drives the length gate and the prose card; every assistant
  // message contributes code snippets.
  const answerSegments = splitBlocks(answerText)
  const prose = joinProseWithPointers(answerSegments)
  const codeBlocks = splitBlocks(allAssistantText).filter((segment) => segment.type === 'code')

  // A short or chatty reply is not worth a prose card — but a substantial code
  // block anywhere in the turn still is, which is why the snippet path is not
  // gated by the length test below.
  const substantialCode = codeBlocks.some((block) => {
    const lines = block.text.split('\n').filter((line) => line.trim() !== '')
    return lines.length >= minCodeLines || block.text.length >= minCodeChars
  })
  if (answerText.length < minChars || isLowValue(answerText)) {
    if (!substantialCode) {
      return {
        drafts,
        reason: drafts.length > 0 ? 'explicit-request-only' : `final answer too short (${answerText.length} < ${minChars})`,
      }
    }
  }

  const title = titleFromRequest(userText || prose)
  if (prose.length >= Math.min(minChars, 200)) {
    const body = prose.slice(0, maxCardChars)
    const hash = contentHash(`${title}\n${body}`)
    drafts.push({
      id: makeId(now, hash),
      title,
      kind: inferKind({ prose: prose.replace(/^> .*知识卡.*$/gm, '').trim(), codeBlocks }),
      tags: extractTags(`${title}\n${body}`, { limit: maxTags }),
      body,
      lang: codeBlocks[0]?.lang ?? '',
      provenance: [provenance],
      createdAt: now,
      updatedAt: now,
      hash,
    })
  }

  let snippetIndex = 0
  for (const block of codeBlocks) {
    const lines = block.text.split('\n').filter((line) => line.trim() !== '')
    if (lines.length < minCodeLines && block.text.length < minCodeChars) continue
    snippetIndex++
    const snippetTitle = `${title} · ${block.lang || 'code'} 片段${codeBlocks.length > 1 ? ` ${snippetIndex}` : ''}`
    const body = `\`\`\`${block.lang || ''}\n${block.text}\n\`\`\`\n\n> 来自：${title}`
    const hash = contentHash(`${snippetTitle}\n${block.text}`)
    drafts.push({
      id: makeId(now, hash),
      title: snippetTitle.slice(0, 80),
      kind: 'snippet',
      tags: extractTags(block.text, { limit: maxTags, extra: [block.lang, title].filter(Boolean) }),
      body,
      lang: block.lang,
      provenance: [provenance],
      createdAt: now,
      updatedAt: now,
      hash,
    })
  }

  return { drafts, reason: drafts.length > 0 ? 'ok' : 'nothing worth keeping' }
}

/**
 * Build a compact digest of a whole session, used by the `brain_capture`
 * tool when the model asks for a full-session sweep rather than the last turn.
 * @param {Array<{role: string, text: string}>} flat
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function sessionDigest(flat, options = {}) {
  const maxChars = options.maxChars ?? 12000
  const parts = []
  for (const message of flat) {
    parts.push(`${message.role === 'user' ? '## 用户' : '## 助手'}\n${summarize(message.text, 1200)}`)
  }
  return parts.join('\n\n').slice(0, maxChars)
}
