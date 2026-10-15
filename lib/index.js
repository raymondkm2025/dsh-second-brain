/**
 * dsh-second-brain host half: a plain Cordis plugin running in the DSH host
 * process.
 *
 * It owns four things:
 *   1. The knowledge vault (Markdown cards on disk — see `store.js`).
 *   2. The capture pipeline: when a turn stops, the finished turn is distilled
 *      into cards, deduplicated against the vault and written.
 *   3. Six `brain_*` model tools, so the model can recall, save, list, capture,
 *      inspect and forget knowledge deliberately.
 *   4. The `/second-brain` HTTP face the browser half (the settings page with
 *      the knowledge base and the force-directed graph) talks to.
 *
 * Every registration is a `ctx.effect` so the plugin row unmounts cleanly.
 *
 * Design notes worth keeping:
 *   - File IO uses `node:fs`, never `ctx.fs`: the host fs service fences writes
 *     under the session workspace policy, which would silently drop cards for a
 *     vault outside the workspace (the default location).
 *   - Capture is fire-and-forget. It must never slow a turn down, never throw
 *     into the agent loop, and never be the reason a turn fails.
 *   - Model-assisted distillation is opt-in. The default path is deterministic
 *     text extraction, so the brain works with no provider configured.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  contentHash,
  exportBundle,
  extractTags,
  makeId,
  minhash,
  slugify,
  summarize,
} from './core.js'
import { distillTurn, flattenMessages, lastTurn, sessionDigest } from './extract.js'
import {
  Vault,
  defaultConfig,
  describeError,
  resolveVaultPath,
  runGit,
  sanitizeConfig,
  stateDir,
  summarizeCard,
  writeFileAtomic,
} from './store.js'

export const name = 'dsh-second-brain'
export const inject = ['tools', 'webServer', 'systemPrompt']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/second-brain'

/**
 * The plugin's own package version, read once at load. `/ping` exposes it so an
 * operator can tell which build the running host actually loaded — the answer
 * to "did my edit take effect?" is otherwise invisible.
 */
const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return String(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/** Upper bound on a request body the settings page may send. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * The prompt section that tells the model the brain exists.
 * Registered as an effect so it disappears with the plugin row.
 */
const PROMPT_SECTION = [
  '本机已挂载「第二大脑」（dsh-second-brain）：一个本地 Markdown 知识库，',
  '对话结束时会自动把值得复用的结论、方案与代码片段沉淀成知识卡（自动去重，支持中文检索，可用 git 管理）。',
  '使用建议：',
  '- 接到「上次/之前/我们讨论过」这类需要回忆的问题时，先调 brain_recall 检索，再回答，不要凭印象编造；',
  '- 产出可复用的方案、命令、配置或代码片段后，主动调 brain_save 明确保存（自动沉淀只覆盖整轮对话的要点）；',
  '- 需要巡视已有知识时用 brain_list / brain_stats；确认某条知识已过时用 brain_forget 删除。',
  '知识库位置与采集策略可在「设置 → 第二大脑」中查看与调整。',
].join('\n')

/**
 * System prompt handed to the model when it does the distilling.
 */
const LLM_DISTILL_SYSTEM = [
  '你是一个知识提炼器。用户会给你一段对话记录，请提取其中「值得长期复用」的知识。',
  '只输出一个 JSON 数组，不要任何解释、不要 markdown 代码围栏。数组元素形如：',
  '{"title":"不超过40字的标题","kind":"fact|procedure|decision|snippet|note","tags":["3到6个小写标签"],"body":"markdown 正文"}',
  '规则：',
  '- 只提取可复用的知识（结论、方案、命令、配置、接口用法、踩坑原因），不要提取寒暄、进度汇报、一次性调试过程；',
  '- 标题必须自含主语，脱离上下文也能看懂；',
  '- body 用简洁的 markdown，保留必要的命令与代码；',
  '- 没有值得保留的内容时输出 []；',
  '- 最多输出 5 条。',
].join('\n')

/**
 * @param {object} ctx
 */
export function apply(ctx) {
  const log = resolveLogger(ctx)

  // ---------------------------------------------------------------- config

  const configFile = join(stateDir(), 'config.json')

  /**
   * Read the persisted config, tolerating a missing or corrupt file.
   * @returns {object}
   */
  function loadConfig() {
    try {
      if (!existsSync(configFile)) return defaultConfig()
      const raw = JSON.parse(readFileSync(configFile, 'utf8'))
      const merged = sanitizeConfig(raw)
      // A legacy/omitted vault field must keep pointing at whatever the file
      // says, not silently jump back to the default.
      if (typeof raw === 'object' && raw !== null && typeof raw.vault === 'string' && raw.vault.trim() !== '') {
        merged.vault = resolveVaultPath(raw.vault)
      }
      return merged
    } catch (error) {
      log.warn(`[dsh-second-brain] 读取配置失败，回退默认值：${describeError(error)}`)
      return defaultConfig()
    }
  }

  let config = loadConfig()

  /**
   * @param {object} patch
   * @returns {object} the merged, sanitized config.
   */
  function saveConfig(patch) {
    config = sanitizeConfig({ ...config, ...patch })
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`)
    } catch (error) {
      log.warn(`[dsh-second-brain] 保存配置失败：${describeError(error)}`)
    }
    return config
  }

  // ----------------------------------------------------------------- vault

  /** @type {Vault} */
  let vault = new Vault({ root: config.vault, logger: log })

  /**
   * Point the vault at a (possibly new) root, recreating the instance and
   * dropping every derived cache when the root actually moved.
   * @param {string} root
   * @returns {Vault}
   */
  function useVault(root) {
    if (vault.root !== root) vault = new Vault({ root, logger: log })
    vault.ensure()
    return vault
  }

  /**
   * Record a successful write for git users who opted in.
   * @param {string} action
   */
  function afterWrite(action) {
    if (config.writeIndexFile) {
      try {
        vault.writeIndexFile()
      } catch (error) {
        log.warn(`[dsh-second-brain] 写入 index.json 失败：${describeError(error)}`)
      }
    }
    if (!config.gitAutoCommit) return
    void vault.gitCommit(`chore(second-brain): ${action}`).catch((error) => {
      log.warn(`[dsh-second-brain] git 自动提交失败：${describeError(error)}`)
    })
  }

  /**
   * Save one card draft with the plugin's dedupe policy applied.
   *
   * Exact duplicates are always folded into the existing card (writing a second
   * copy of the same knowledge is never useful). Near duplicates are folded only
   * when `autoMergeDuplicates` is on; otherwise the new card is written and both
   * sides are cross-linked. Merely-related cards are only linked.
   *
   * @param {object} draft
   * @returns {{ action: 'created'|'merged'|'skipped', id: string, similarity?: number }}
   */
  function persistDraft(draft) {
    vault.touch()
    const body = String(draft.body ?? '')
    const title = String(draft.title ?? '未命名')
    const hash = draft.hash ?? contentHash(`${title}\n${body}`)
    const sig = minhash(`${title}\n${body}`).sig
    const { duplicates, related } = vault.findSimilar(
      { title, body, hash, sig },
      { threshold: config.dedupeThreshold, relatedThreshold: config.relatedThreshold },
    )

    const exact = duplicates.find((item) => item.verdict === 'exact')
    const target = duplicates[0]

    if (target !== undefined) {
      const shouldMerge = exact !== undefined || config.autoMergeDuplicates
      if (!shouldMerge) {
        const created = writeNew(draft, duplicates.concat(related))
        return { action: 'created', id: created, similarity: target.similarity }
      }
      const existing = target.card
      const keepDraftBody = body.length > (existing.body?.length ?? 0)
      const nextBody = keepDraftBody ? body : existing.body
      const tags = unionTags(existing.tags, draft.tags)
      const provenance = unionList(existing.provenance, draft.provenance)
      const links = unionList(existing.links, (draft.links ?? []).concat(related.slice(0, 3).map((item) => item.card.id)))
      const merged = {
        ...existing,
        tags,
        provenance,
        links: links.filter((id) => id !== existing.id),
        updatedAt: Date.now(),
        pinned: existing.pinned === true || draft.pinned === true,
        body: nextBody,
        hash: contentHash(`${existing.title}\n${nextBody}`),
      }
      clearVaultBodyCache()
      vault.write(merged, nextBody)
      return { action: 'merged', id: merged.id, similarity: target.similarity, containment: target.containment }
    }

    const created = writeNew(draft, related)
    return { action: 'created', id: created }
  }

  /**
   * @param {object} draft
   * @param {Array<{card: object, similarity: number}>} related
   * @returns {string} the new card id.
   */
  function writeNew(draft, related) {
    const body = String(draft.body ?? '')
    const title = String(draft.title ?? '未命名')
    const hash = contentHash(`${title}\n${body}`)
    const autoLinks = config.linkRelated
      ? related.filter((item) => item.similarity >= config.relatedThreshold).slice(0, 3).map((item) => item.card.id)
      : []
    const card = {
      id: draft.id ?? makeId(draft.createdAt ?? Date.now(), hash),
      title,
      kind: draft.kind ?? 'fact',
      tags: draft.tags ?? [],
      links: unionList(draft.links ?? [], autoLinks),
      provenance: draft.provenance ?? [],
      createdAt: draft.createdAt ?? Date.now(),
      updatedAt: draft.updatedAt ?? Date.now(),
      hash,
      pinned: draft.pinned === true,
      lang: draft.lang ?? '',
    }
    vault.write(card, body)
    return card.id
  }

  /**
   * `Vault.write` keeps the previous card object in its mtime cache; a merge
   * mutates a copy, so force the next read to come from disk.
   */
  function clearVaultBodyCache() {
    vault.dirty = true
  }

  // --------------------------------------------------------------- capture

  /** Turn keys already captured, so a repeated turn-stopping event is a no-op. */
  const capturedTurns = new Set()

  /**
   * Distill the end of a session into cards.
   * @param {object} input
   * @param {string} input.sessionId
   * @param {number} [input.turn]
   * @param {boolean} [input.whole] capture the whole session instead of the last turn
   * @param {boolean} [input.force] ignore the per-turn dedupe set
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<object>}
   */
  async function captureSession(input) {
    if (config.capture === 'off' && input.force !== true) {
      return { ok: false, skipped: true, reason: 'capture 已关闭', created: 0, merged: 0, ids: [] }
    }
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') {
      return { ok: false, skipped: true, reason: 'ctx.sessions 不可用', created: 0, merged: 0, ids: [] }
    }
    const session = sessions.get(input.sessionId)
    if (session === undefined || typeof session.deriveMessages !== 'function') {
      return { ok: false, skipped: true, reason: `找不到会话 ${input.sessionId}`, created: 0, merged: 0, ids: [] }
    }
    const flat = flattenMessages(session.deriveMessages())
    if (flat.length === 0) {
      return { ok: false, skipped: true, reason: '会话没有可提炼的文本', created: 0, merged: 0, ids: [] }
    }
    const messages = input.whole === true ? flat : lastTurn(flat)
    const turnKey = `${input.sessionId}#${input.turn ?? 'last'}#${contentHash(messages.map((item) => item.text).join('\n'))}`
    if (input.force !== true) {
      if (capturedTurns.has(turnKey)) {
        return { ok: true, skipped: true, reason: '该轮已采集', created: 0, merged: 0, ids: [] }
      }
      capturedTurns.add(turnKey)
      if (capturedTurns.size > 4000) capturedTurns.clear()
    }

    const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
    let drafts = []
    let mode = config.capture

    if (config.capture === 'llm') {
      const drafted = await distillWithModel(messages, input.signal)
      if (drafted.ok) {
        mode = 'llm'
        drafts = drafted.drafts
        if (drafts.length === 0) {
          // The model examined the turn and judged it to hold nothing reusable.
          // Falling through to the heuristic extractor here would override that
          // verdict — and the heuristics always find *something* in a long reply
          // (a card titled after the user's own message, plus one per code
          // fence), which is precisely the noise this mode exists to prevent.
          capturedTurns.add(turnKey)
          return { ok: true, skipped: true, reason: '模型判断本轮无可沉淀内容', created: 0, merged: 0, ids: [], mode }
        }
      } else if (config.heuristicFallback === true) {
        // Opt-in only. The deterministic extractor always finds *something* in a
        // long reply — a card titled after the user's own message, plus one per
        // code fence — which is exactly the noise this mode exists to avoid, so
        // substituting it for a failed model call is the wrong default.
        mode = 'heuristic'
        log.warn('[dsh-second-brain] 模型提炼不可用，按配置回退启发式采集')
      } else {
        capturedTurns.add(turnKey)
        return {
          ok: true,
          skipped: true,
          reason: '模型提炼不可用，已跳过本轮（可在「设置 → 第二大脑」开启启发式回退）',
          created: 0,
          merged: 0,
          ids: [],
          mode: 'llm',
        }
      }
    }
    if (drafts.length === 0) {
      const result = distillTurn({
        messages,
        sessionId: input.sessionId,
        cwd,
        turn: input.turn ?? 0,
        options: {
          minChars: config.minChars,
          maxCardChars: config.maxCardChars,
          tagsLimit: config.tagsLimit,
          minCodeLines: config.minCodeLines,
          minCodeChars: config.minCodeChars,
        },
      })
      drafts = result.drafts
      if (drafts.length === 0) {
        return { ok: true, skipped: true, reason: result.reason, created: 0, merged: 0, ids: [], mode }
      }
    }

    const ids = []
    let created = 0
    let merged = 0
    for (const draft of drafts) {
      try {
        const outcome = persistDraft(draft)
        if (outcome.action === 'created') created++
        else if (outcome.action === 'merged') merged++
        ids.push(outcome.id)
      } catch (error) {
        log.warn(`[dsh-second-brain] 写入知识卡失败：${describeError(error)}`)
      }
    }
    if (ids.length > 0) afterWrite(`采集 ${ids.length} 张知识卡`)
    return { ok: true, skipped: false, mode, created, merged, ids, turn: input.turn ?? 0 }
  }

  /**
   * Optional model-assisted distillation. Returns `null` whenever the model
   * route is unavailable or answers something unusable, so the caller silently
   * falls back to the deterministic extractor.
   * @param {Array<{role: string, text: string}>} messages
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ ok: true, drafts: Array<object> } | { ok: false }>}
   */
  async function distillWithModel(messages, signal) {
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return { ok: false }
    const route = resolveModelRoute()
    if (route === null) return { ok: false }
    const transcript = messages
      .map((item) => `${item.role === 'user' ? '【用户】' : '【助手】'}\n${item.text}`)
      .join('\n\n')
      .slice(-24000)
    let text = ''
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: LLM_DISTILL_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
        maxTokens: 3000,
        ...(signal === undefined ? {} : { signal }),
      })
      for await (const chunk of stream) {
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta') text += chunk.text
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind !== undefined && kind !== 'stop' && kind !== 'max-tokens') return { ok: false }
        }
      }
    } catch (error) {
      log.warn(`[dsh-second-brain] 模型提炼失败，回退启发式：${describeError(error)}`)
      return { ok: false }
    }
    return parseDraftJson(text)
  }

  /**
   * @returns {{provider: string, model: string} | null}
   */
  function resolveModelRoute() {
    if (config.llmProvider !== '' && config.llmModel !== '') {
      return { provider: config.llmProvider, model: config.llmModel }
    }
    const defaults = ctx.get('agentDefaultModel')
    if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
      try {
        const selection = defaults.currentSelection()
        if (selection !== undefined && selection !== null && typeof selection.provider === 'string' && typeof selection.model === 'string') {
          return { provider: selection.provider, model: selection.model }
        }
      } catch {
        /* fall through */
      }
    }
    return null
  }

  // ----------------------------------------------------------------- tools

  const recallTool = {
    name: 'brain_recall',
    description:
      '检索本机「第二大脑」知识库（本地 Markdown 知识卡，支持中文检索与自动去重）。当用户问「上次/之前/我们讨论过/你还记得」这类需要回忆历史结论的问题时，先调用它再做回答。返回按相关度排序的知识卡摘要与片段。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言问题，中文英文均可' },
        limit: { type: 'number', description: '返回条数，1-50，默认 8' },
        tag: { type: 'string', description: '可选：只在该标签下检索' },
        kind: { type: 'string', description: '可选：限定知识类型（fact/procedure/decision/snippet/note）' },
        with_body: { type: 'boolean', description: '是否返回知识卡正文（默认 false，只返回摘要）' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number' },
          vault: { type: 'string' },
          notice: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                kind: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                summary: { type: 'string' },
                snippet: { type: 'string' },
                body: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        const count = value?.count ?? 0
        if (count === 0) return [{ type: 'text', text: value?.notice || '第二大脑里没有匹配的知识卡。' }]
        const lines = (value?.results ?? []).map((item, index) => {
          const head = `${index + 1}. ${item.title}　[${item.kind}]${item.tags?.length ? ' #' + item.tags.join(' #') : ''}`
          return `${head}\n   ${item.body || item.snippet || item.summary}`
        })
        return [{ type: 'text', text: `第二大脑检索到 ${count} 条：\n\n${lines.join('\n\n')}` }]
      },
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') return { count: 0, vault: vault.root, notice: 'query 不能为空', results: [] }
      const limit = clampNumber(args?.limit, 1, 50, 8)
      const filters = {}
      if (typeof args?.tag === 'string' && args.tag !== '') filters.tag = args.tag
      if (typeof args?.kind === 'string' && args.kind !== '') filters.kind = args.kind
      const withBody = args?.with_body === true
      const hits = vault.search(query, { limit, filters })
      return {
        count: hits.length,
        vault: vault.root,
        notice: hits.length === 0 ? `没有匹配「${query}」的知识卡（知识库共 ${vault.list().length} 张）。` : `按相关度返回 ${hits.length} 条。`,
        results: hits.map((hit) => ({
          id: hit.id,
          title: hit.title,
          kind: hit.kind,
          tags: hit.tags,
          score: hit.score,
          summary: hit.summary,
          snippet: hit.snippet,
          body: withBody ? (vault.get(hit.id)?.body ?? '').slice(0, 6000) : '',
        })),
      }
    },
  }

  const saveTool = {
    name: 'brain_save',
    description:
      '把一条值得长期复用的知识显式存入本机「第二大脑」（本地 Markdown 知识卡）。适合保存结论、方案、命令、配置、接口用法、踩坑原因。写入时自动去重：与已有知识卡重复时合并而不是新建。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '标题，必须自含主语，脱离上下文也能看懂' },
        body: { type: 'string', description: 'markdown 正文' },
        kind: { type: 'string', description: '类型：fact（事实）/ procedure（步骤）/ decision（决策）/ snippet（代码片段）/ note（笔记），默认 fact' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，2-6 个' },
        links: { type: 'array', items: { type: 'string' }, description: '可选：关联的知识卡 id' },
      },
      required: ['title', 'body'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          id: { type: 'string' },
          similarity: { type: 'number' },
          file: { type: 'string' },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value?.notice || '知识卡保存失败' }]
      },
    },
    async execute(args) {
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      const body = typeof args?.body === 'string' ? args.body.trim() : ''
      if (title === '' || body === '') {
        return { ok: false, action: 'none', id: '', similarity: 0, file: '', notice: 'title 与 body 都不能为空' }
      }
      const tags = Array.isArray(args?.tags)
        ? args.tags.map((tag) => String(tag).toLowerCase().trim()).filter(Boolean).slice(0, 10)
        : extractTags(`${title}\n${body}`, { limit: config.tagsLimit })
      const outcome = persistDraft({
        title,
        body,
        kind: typeof args?.kind === 'string' && args.kind !== '' ? args.kind : 'fact',
        tags,
        links: Array.isArray(args?.links) ? args.links.map(String) : [],
        provenance: ['brain_save'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      if (outcome.action !== 'skipped') afterWrite(`brain_save ${outcome.id}`)
      const card = vault.get(outcome.id)
      const notice = outcome.action === 'merged'
        ? `已与现有知识卡合并（相似度 ${(outcome.similarity ?? 0).toFixed(2)}）：${card?.title ?? outcome.id}`
        : `已存入第二大脑：${title}（${card?.file ?? outcome.id}）`
      return { ok: true, action: outcome.action, id: outcome.id, similarity: outcome.similarity ?? 0, file: card?.file ?? '', notice }
    },
  }

  const listTool = {
    name: 'brain_list',
    description: '按时间倒序列出本机「第二大脑」的知识卡（可按标签或类型过滤）。用于巡视已有知识、确认某条知识是否存在。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string', description: '可选：只看带该标签的知识卡' },
        kind: { type: 'string', description: '可选：只看该类型' },
        limit: { type: 'number', description: '返回条数，1-100，默认 20' },
        offset: { type: 'number', description: '分页偏移，默认 0' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          count: { type: 'number' },
          vault: { type: 'string' },
          notice: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                kind: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                updatedAt: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
        },
      },
      render(_args, value) {
        if ((value?.count ?? 0) === 0) return [{ type: 'text', text: value?.notice || '知识库为空。' }]
        const lines = (value?.items ?? []).map((item) => `- ${item.title}　[${item.kind}]${item.tags?.length ? ' #' + item.tags.join(' #') : ''}\n  ${item.summary}`)
        return [{ type: 'text', text: `共 ${value.total} 张，本页 ${value.count} 张：\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      let cards = vault.list()
      if (typeof args?.tag === 'string' && args.tag !== '') cards = cards.filter((card) => card.tags.includes(args.tag))
      if (typeof args?.kind === 'string' && args.kind !== '') cards = cards.filter((card) => card.kind === args.kind)
      const limit = clampNumber(args?.limit, 1, 100, 20)
      const offset = clampNumber(args?.offset, 0, 100000, 0)
      const page = cards.slice(offset, offset + limit)
      return {
        total: cards.length,
        count: page.length,
        vault: vault.root,
        notice: cards.length === 0 ? '知识库为空（或没有匹配的知识卡）。' : '',
        items: page.map((card) => ({
          id: card.id,
          title: card.title,
          kind: card.kind,
          tags: card.tags,
          updatedAt: new Date(card.updatedAt).toISOString(),
          summary: summarize(card.body ?? '', 140),
        })),
      }
    },
  }

  const captureTool = {
    name: 'brain_capture',
    description:
      '立即把当前会话（或其中最后一轮）提炼成本机「第二大脑」的知识卡。对话结束时会自动采集，这个工具用于用户明确说「记住这次讨论/把这轮存下来」时手动触发。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        whole: { type: 'boolean', description: 'true=提炼整个会话，false/缺省=只提炼最后一轮' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          skipped: { type: 'boolean' },
          created: { type: 'number' },
          merged: { type: 'number' },
          ids: { type: 'array', items: { type: 'string' } },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value?.notice || '采集完成' }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, skipped: true, created: 0, merged: 0, ids: [], notice: '当前工具调用没有绑定的会话，无法采集。' }
      }
      const result = await captureSession({ sessionId, whole: args?.whole === true, force: true, signal: exec?.signal })
      if (result.skipped) return { ok: false, skipped: true, created: 0, merged: 0, ids: [], notice: `没有采集：${result.reason}` }
      return {
        ok: true,
        skipped: false,
        created: result.created,
        merged: result.merged,
        ids: result.ids,
        notice: `已采集：新增 ${result.created} 张、合并 ${result.merged} 张知识卡（${result.ids.join('、')}）。`,
      }
    },
  }

  const statsTool = {
    name: 'brain_stats',
    description: '查看本机「第二大脑」的概况：知识卡数量、标签、存储路径、采集策略与最近更新时间。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cards: { type: 'number' },
          tags: { type: 'number' },
          links: { type: 'number' },
          bytes: { type: 'number' },
          vault: { type: 'string' },
          capture: { type: 'string' },
          latest: { type: 'string' },
          topTags: { type: 'array', items: { type: 'string' } },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value?.notice || '第二大脑统计' }]
      },
    },
    async execute() {
      const stats = vault.stats()
      const topTags = vault.graph().tags.slice(0, 12).map((tag) => `${tag.name}(${tag.count})`)
      const latest = stats.latest === 0 ? '（尚无知识卡）' : new Date(stats.latest).toISOString()
      return {
        cards: stats.cards,
        tags: stats.tags,
        links: stats.links,
        bytes: stats.bytes,
        vault: stats.vault,
        capture: config.capture,
        latest,
        topTags,
        notice: `第二大脑：${stats.cards} 张知识卡 / ${stats.tags} 个标签 / ${stats.links} 条关联，共 ${stats.bytes} 字，最近更新 ${latest}。\n存储路径：${stats.vault}\n采集策略：${config.capture}\n热门标签：${topTags.join('、') || '（无）'}`,
      }
    },
  }

  const forgetTool = {
    name: 'brain_forget',
    description: '删除本机「第二大脑」中的知识卡（按 id 精确删除，或按标题关键词匹配）。删除会直接移除对应的 Markdown 文件，请先与用户确认。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '要删除的知识卡 id' },
        title: { type: 'string', description: '按标题关键词匹配删除（精确 id 优先）' },
        dry_run: { type: 'boolean', description: 'true=只列出将被删除的条目而不真的删除' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          deleted: { type: 'array', items: { type: 'string' } },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' } },
            },
          },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value?.notice || '删除完成' }]
      },
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id !== '') {
        const card = vault.get(id)
        if (card === undefined) return { ok: false, deleted: [], candidates: [], notice: `没有找到 id 为 ${id} 的知识卡。` }
        if (args?.dry_run === true) {
          return { ok: true, deleted: [], candidates: [{ id: card.id, title: card.title, kind: card.kind }], notice: `将删除：${card.title}（试运行，未执行）` }
        }
        vault.remove([id])
        afterWrite(`删除 ${id}`)
        return { ok: true, deleted: [id], candidates: [], notice: `已删除《${card.title}》。` }
      }
      const keyword = typeof args?.title === 'string' ? args.title.trim().toLowerCase() : ''
      if (keyword === '') return { ok: false, deleted: [], candidates: [], notice: '请提供 id 或 title。' }
      const matches = vault.list().filter((card) => card.title.toLowerCase().includes(keyword))
      if (matches.length === 0) return { ok: false, deleted: [], candidates: [], notice: `没有标题包含「${keyword}」的知识卡。` }
      if (matches.length > 1 || args?.dry_run === true) {
        return {
          ok: true,
          deleted: [],
          candidates: matches.slice(0, 20).map((card) => ({ id: card.id, title: card.title, kind: card.kind })),
          notice: `匹配到 ${matches.length} 张，请用 id 精确指定：\n${matches.slice(0, 20).map((card) => `- ${card.id}　${card.title}`).join('\n')}`,
        }
      }
      vault.remove([matches[0].id])
      afterWrite(`删除 ${matches[0].id}`)
      return { ok: true, deleted: [matches[0].id], candidates: [], notice: `已删除《${matches[0].title}》。` }
    },
  }

  ctx.effect(() => ctx.tools.register(recallTool), 'second-brain: brain_recall tool')
  ctx.effect(() => ctx.tools.register(saveTool), 'second-brain: brain_save tool')
  ctx.effect(() => ctx.tools.register(listTool), 'second-brain: brain_list tool')
  ctx.effect(() => ctx.tools.register(captureTool), 'second-brain: brain_capture tool')
  ctx.effect(() => ctx.tools.register(statsTool), 'second-brain: brain_stats tool')
  ctx.effect(() => ctx.tools.register(forgetTool), 'second-brain: brain_forget tool')

  // -------------------------------------------------------------- prompt

  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'tool:second-brain', order: 118, text: PROMPT_SECTION }),
    'second-brain: prompt section',
  )

  // --------------------------------------------------------------- events

  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    const sessionId = payload?.agent?.session?.id ?? payload?.agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const turn = typeof payload?.turn === 'number' ? payload.turn : 0
    // Fire-and-forget: a knowledge capture must never delay or fail a turn.
    void Promise.resolve()
      .then(() => captureSession({ sessionId, turn }))
      .catch((error) => log.warn(`[dsh-second-brain] 自动采集失败：${describeError(error)}`))
  }, { global: true }), 'second-brain: capture on turn stop')

  // --------------------------------------------------------------- routes

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {unknown} value
   * @param {number} [status]
   */
  const writeJson = (res, value, status = 200) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<object>}
   */
  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体过大')
        error.status = 413
        throw error
      }
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return {}
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      const error = new Error('请求体不是合法 JSON')
      error.status = 400
      throw error
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const error = new Error('请求体必须是一个 JSON 对象')
      error.status = 400
      throw error
    }
    return parsed
  }

  /**
   * The `/second-brain` handler. Every route is a small pure function over the
   * vault; failures are answered as JSON errors so the settings page can show
   * them instead of a blank panel.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname
      const method = String(req.method ?? 'GET').toUpperCase()
      const query = url.searchParams

      // CSRF gate. This prefix is served by the host's web server without any
      // origin check in front of it, and `readJsonBody` would happily parse a
      // `text/plain` body — which is exactly the shape a cross-origin "simple"
      // request can send without a preflight. Demanding `application/json`
      // forces any cross-origin caller into a preflight this server never
      // answers, and the Origin check rejects the rest.
      if (method !== 'GET' && method !== 'HEAD') {
        const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          writeJson(res, { ok: false, error: '写操作需要 content-type: application/json' }, 415)
          return
        }
        const origin = req.headers?.origin
        if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
          const host = req.headers?.host
          let originHost = ''
          try {
            originHost = new URL(origin).host
          } catch {
            originHost = ''
          }
          if (typeof host !== 'string' || originHost === '' || originHost !== host) {
            writeJson(res, { ok: false, error: '拒绝跨站写操作' }, 403)
            return
          }
        }
      }

      vault.ensure()

      if (route === '/ping') {
        writeJson(res, { ok: true, name, version: PKG_VERSION, vault: vault.root, cards: vault.list().length })
        return
      }

      if (route === '/overview') {
        const graph = vault.graph()
        writeJson(res, {
          ok: true,
          config,
          stats: vault.stats(),
          tags: graph.tags,
          kinds: countKinds(vault.list()),
          stateDir: stateDir(),
        })
        return
      }

      if (route === '/config' && method === 'GET') {
        writeJson(res, { ok: true, config, stateDir: stateDir(), defaultVault: config.vault })
        return
      }

      if (route === '/config' && method === 'POST') {
        const body = await readJsonBody(req)
        const patch = typeof body.patch === 'object' && body.patch !== null ? body.patch : body
        if (typeof patch.vault === 'string') {
          const nextRoot = resolveVaultPath(patch.vault)
          try {
            mkdirSync(join(nextRoot, 'cards'), { recursive: true })
          } catch (error) {
            writeJson(res, { ok: false, error: `无法创建知识库目录：${describeError(error)}` }, 400)
            return
          }
          patch.vault = nextRoot
        }
        const next = saveConfig(patch)
        useVault(next.vault)
        writeJson(res, { ok: true, config: next })
        return
      }

      if (route === '/list' && method === 'GET') {
        const query_text = (query.get('q') ?? '').trim()
        const tag = query.get('tag') ?? ''
        const kind = query.get('kind') ?? ''
        const limit = clampNumber(query.get('limit'), 1, 500, 60)
        const offset = clampNumber(query.get('offset'), 0, 1000000, 0)
        let cards = vault.list()
        if (tag !== '') cards = cards.filter((card) => card.tags.includes(tag))
        if (kind !== '') cards = cards.filter((card) => card.kind === kind)
        if (query_text !== '') {
          const ranked = vault.search(query_text, { limit: cards.length === 0 ? limit : Math.max(limit, cards.length) })
          const allowed = new Set(cards.map((card) => card.id))
          const ordered = ranked.map((hit) => vault.get(hit.id)).filter((card) => card !== undefined && allowed.has(card.id))
          const seen = new Set(ordered.map((card) => card.id))
          for (const card of cards) if (!seen.has(card.id)) ordered.push(card)
          cards = ordered
        }
        const page = cards.slice(offset, offset + limit)
        writeJson(res, { ok: true, total: cards.length, offset, limit, items: page.map(summarizeCard) })
        return
      }

      if (route === '/search' && method === 'GET') {
        const q = (query.get('q') ?? '').trim()
        const limit = clampNumber(query.get('limit'), 1, 100, 20)
        const filters = {}
        const tag = query.get('tag') ?? ''
        const kind = query.get('kind') ?? ''
        if (tag !== '') filters.tag = tag
        if (kind !== '') filters.kind = kind
        writeJson(res, { ok: true, query: q, results: q === '' ? [] : vault.search(q, { limit, filters }) })
        return
      }

      if (route === '/card' && method === 'GET') {
        const card = vault.get(query.get('id') ?? '')
        if (card === undefined) {
          writeJson(res, { ok: false, error: '知识卡不存在' }, 404)
          return
        }
        writeJson(res, { ok: true, card: { ...summarizeCard(card), body: card.body } })
        return
      }

      if (route === '/card' && method === 'POST') {
        const body = await readJsonBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        const text = typeof body.body === 'string' ? body.body : ''
        if (title === '') {
          writeJson(res, { ok: false, error: '标题不能为空' }, 400)
          return
        }
        const existing = id === '' ? undefined : vault.get(id)
        const now = Date.now()
        const tags = Array.isArray(body.tags)
          ? body.tags.map((tag) => String(tag).toLowerCase().trim()).filter(Boolean)
          : extractTags(`${title}\n${text}`, { limit: config.tagsLimit })
        const card = {
          id: existing?.id ?? makeId(now, contentHash(`${title}\n${text}`)),
          title,
          kind: typeof body.kind === 'string' && body.kind !== '' ? body.kind : (existing?.kind ?? 'fact'),
          tags,
          links: Array.isArray(body.links) ? body.links.map(String).filter((link) => link !== id) : (existing?.links ?? []),
          provenance: Array.isArray(body.provenance) ? body.provenance.map(String) : (existing?.provenance ?? ['manual']),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          hash: contentHash(`${title}\n${text}`),
          pinned: typeof body.pinned === 'boolean' ? body.pinned : existing?.pinned === true,
          lang: typeof body.lang === 'string' ? body.lang : (existing?.lang ?? ''),
        }
        clearVaultBodyCache()
        // An explicit id means "edit this card", so a title+body change must not
        // be mistaken for an id collision and mint a second card.
        vault.write(card, text, { reassignOnCollision: false })
        afterWrite(`保存 ${card.id}`)
        const saved = vault.get(card.id)
        writeJson(res, { ok: true, card: { ...summarizeCard(saved), body: saved.body } })
        return
      }

      if (route === '/delete' && method === 'POST') {
        const body = await readJsonBody(req)
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
        if (ids.length === 0) {
          writeJson(res, { ok: false, error: '没有指定要删除的知识卡' }, 400)
          return
        }
        const result = vault.remove(ids)
        afterWrite(`删除 ${result.deleted.length} 张知识卡`)
        writeJson(res, { ok: true, deleted: result.deleted })
        return
      }

      if (route === '/merge' && method === 'POST') {
        const body = await readJsonBody(req)
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
        if (ids.length < 2) {
          writeJson(res, { ok: false, error: '合并至少需要选中两张知识卡' }, 400)
          return
        }
        try {
          const result = vault.merge(ids, { title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined })
          afterWrite(`合并 ${ids.length} 张知识卡`)
          writeJson(res, { ok: true, card: summarizeCard(result.card), removed: result.removed })
        } catch (error) {
          writeJson(res, { ok: false, error: describeError(error) }, 400)
        }
        return
      }

      if (route === '/graph' && method === 'GET') {
        const graph = vault.graph()
        writeJson(res, { ok: true, nodes: graph.nodes, edges: graph.edges, tags: graph.tags, vault: vault.root })
        return
      }

      if (route === '/export' && method === 'GET') {
        const bundle = typeof query.get('ids') === 'string' && query.get('ids') !== ''
          ? exportBundle(query.get('ids').split(',').map((id) => vault.get(id)).filter((card) => card !== undefined).map((card) => ({ card, body: card.body })))
          : vault.exportAll()
        if (query.get('download') === '1') {
          const text = JSON.stringify(bundle, null, 2)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="second-brain-${new Date().toISOString().slice(0, 10)}.json"`,
            'content-length': Buffer.byteLength(text),
          })
          res.end(text)
          return
        }
        writeJson(res, { ok: true, bundle })
        return
      }

      if (route === '/import' && method === 'POST') {
        const body = await readJsonBody(req)
        // 'replace' empties the vault before writing, so it is never inferred:
        // the caller must say so twice — `mode` and an explicit `confirm`.
        const wantsReplace = body.mode === 'replace'
        if (wantsReplace && body.confirm !== 'replace') {
          writeJson(res, { ok: false, error: "以 replace 导入会清空现有知识库，需要在请求里带上 confirm: 'replace'" }, 400)
          return
        }
        const mode = wantsReplace ? 'replace' : 'merge'
        const result = vault.importAll(body.bundle ?? body, { mode })
        afterWrite(`导入 ${result.imported} 张知识卡`)
        writeJson(res, { ok: true, ...result, stats: vault.stats() })
        return
      }

      if (route === '/reindex' && method === 'POST') {
        vault.scan({ force: true })
        writeJson(res, { ok: true, stats: vault.stats() })
        return
      }

      if (route === '/git' && method === 'POST') {
        const body = await readJsonBody(req)
        const action = typeof body.action === 'string' ? body.action : 'status'
        if (action === 'init') {
          const result = await vault.gitInit()
          writeJson(res, { ok: result.ok, output: result.output })
          return
        }
        if (action === 'commit') {
          const result = await vault.gitCommit(typeof body.message === 'string' && body.message.trim() !== '' ? body.message.trim() : undefined)
          writeJson(res, { ok: result.ok, output: result.output })
          return
        }
        const status = await runGit(vault.root, ['status', '--short'])
        writeJson(res, { ok: status.ok, output: status.stdout || status.stderr || '（工作区干净）' })
        return
      }

      if (route === '/capture' && method === 'POST') {
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          writeJson(res, { ok: false, error: '缺少 sessionId' }, 400)
          return
        }
        const result = await captureSession({ sessionId, whole: body.whole === true, force: true })
        writeJson(res, { ok: result.ok, ...result })
        return
      }

      writeJson(res, { ok: false, error: `未知路由 ${method} ${route}` }, 404)
    } catch (error) {
      try {
        const status = typeof error?.status === 'number' ? error.status : 500
        writeJson(res, { ok: false, error: describeError(error) }, status)
      } catch {
        /* response already gone */
      }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: serve }),
    'second-brain: routes',
  )

  log.info(`[dsh-second-brain] v${PKG_VERSION} 已挂载，知识库：${vault.root}（采集策略：${config.capture}）`)

  // Exposed for tests and for `brain_capture` from the HTTP face.
  return { captureSession, persistDraft, vault: () => vault, config: () => config }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Resolve a logger without assuming the host shape.
 * @param {object} ctx
 * @returns {{info: Function, warn: Function}}
 */
function resolveLogger(ctx) {
  try {
    if (typeof ctx?.logger === 'function') {
      const logger = ctx.logger('dsh-second-brain')
      if (logger !== undefined && typeof logger.warn === 'function') return logger
    }
  } catch {
    /* fall through */
  }
  return { info: () => {}, warn: () => {} }
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {string[]}
 */
function unionTags(left, right) {
  const out = []
  const seen = new Set()
  for (const tag of [...(left ?? []), ...(right ?? [])]) {
    const value = String(tag).trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {string[]}
 */
function unionList(left, right) {
  const out = []
  const seen = new Set()
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const value = String(item).trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * @param {object[]} cards
 * @returns {Array<{name: string, count: number}>}
 */
function countKinds(cards) {
  const counts = new Map()
  for (const card of cards) counts.set(card.kind, (counts.get(card.kind) ?? 0) + 1)
  return [...counts.entries()].map(([kind, count]) => ({ name: kind, count })).sort((left, right) => right.count - left.count)
}

/**
 * Recover every COMPLETE top-level `{…}` object from a truncated JSON array.
 *
 * A model answer cut off by the token budget is a partial answer, not a failed
 * one: the objects before the cut are perfectly good drafts. Scanner is
 * string-aware so a `}` inside a body does not close an object early.
 * @param {string} text the text after the opening `[`
 * @returns {Array<unknown>}
 */
function salvageObjects(text) {
  const found = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try { found.push(JSON.parse(text.slice(start, i + 1))) } catch { /* skip an unparsable fragment */ }
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return found
}

/**
 * Turn parsed model objects into card drafts, dropping entries that cannot make
 * a card (no title, no body).
 * @param {Array<unknown>} items
 * @returns {Array<object>}
 */
function toDrafts(items) {
  const now = Date.now()
  const drafts = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const body = typeof item.body === 'string' ? item.body.trim() : ''
    if (title === '' || body === '') continue
    const hash = contentHash(`${title}\n${body}`)
    drafts.push({
      id: makeId(now, hash),
      title: title.slice(0, 120),
      body,
      kind: typeof item.kind === 'string' && item.kind !== '' ? item.kind : 'fact',
      tags: Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).toLowerCase()).filter(Boolean).slice(0, 8) : [],
      links: [],
      provenance: ['auto-capture:llm'],
      createdAt: now,
      updatedAt: now,
      hash,
      lang: '',
    })
    if (drafts.length >= 8) break
  }
  return drafts
}

/**
 * Pull a JSON array of card drafts out of a model answer, tolerating prose
 * around it, markdown fences, and truncation.
 *
 * The result is deliberately discriminated. An empty array is a VALID ANSWER —
 * the model looked at the turn and decided it holds nothing reusable — and must
 * not be confused with an unusable reply. Conflating the two is what made the
 * heuristics run as a "fallback" exactly when the model said "nothing here",
 * producing cards titled after the user's own message.
 *
 * A truncated array is treated as a valid answer too, carrying whatever complete
 * entries it got out.
 *
 * @param {string} text
 * @returns {{ ok: true, drafts: Array<object> } | { ok: false }}
 */
export function parseDraftJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('[')
  if (start < 0) return { ok: false }
  const end = source.lastIndexOf(']')
  if (end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1))
      if (Array.isArray(parsed)) return { ok: true, drafts: toDrafts(parsed) }
    } catch {
      /* fall through to the salvage path */
    }
  }
  const salvaged = salvageObjects(source.slice(start + 1))
  if (salvaged.length === 0) return { ok: false }
  return { ok: true, drafts: toDrafts(salvaged) }
}

export { slugify, sessionDigest, summarizeCard }
