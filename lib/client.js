/**
 * dsh-second-brain client half: the settings page.
 *
 * Loaded by the Web ModuleLoader as a plain React plugin (no build step — see
 * the shipped `dsh-music-player` for the same hand-written pattern). It
 * registers exactly one `settings.section` page, 「第二大脑」, and talks to the
 * host half over the plugin's own `/second-brain` HTTP routes: `@Remote` is a
 * build-time Typert artifact and is not usable from a hand-written bundle.
 *
 * The page has three tabs:
 *   知识库   — search, tag/kind filters, the card list, and a card editor.
 *   知识图谱 — an SVG force-directed graph with legend filtering, a time
 *              dimension, pan/zoom, node dragging and marquee box selection,
 *              plus merge / export / import over the selection.
 *   设置     — vault path, capture policy, dedupe thresholds and git actions.
 *
 * Pure helpers (layout, filtering, colouring) are attached to `exports.__test`
 * so the test suite can exercise them in Node without a DOM.
 */
window.__ModuleLoader__.load({
  id: 'dsh-second-brain',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const BASE = '/second-brain';

    /* ---------------------------------------------------------------- *
     * Host transport
     * ---------------------------------------------------------------- */

    /**
     * Call the host half. Always resolves to a JSON object; transport and
     * non-JSON failures come back as `{ ok: false, error }`.
     * @param {string} path
     * @param {{ method?: string, body?: unknown }} [options]
     * @returns {Promise<object>}
     */
    async function api(path, options) {
      const method = (options && options.method) || 'GET';
      try {
        const response = await fetch(BASE + path, {
          method,
          cache: 'no-store',
          ...(options && options.body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }
            : {}),
        });
        const text = await response.text();
        if (text === '') return { ok: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
        try {
          return JSON.parse(text);
        } catch {
          return { ok: false, error: `响应不是 JSON（HTTP ${response.status}）` };
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    }

    /* ---------------------------------------------------------------- *
     * Pure helpers
     * ---------------------------------------------------------------- */

    /** Deterministic 32-bit PRNG so a graph keeps its shape across renders. */
    function mulberry32(seed) {
      let a = seed >>> 0;
      return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), 1 | t);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** Stable string hash used to seed the layout and pick tag colours. */
    function hashString(input) {
      const text = String(input == null ? '' : input);
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h >>> 0;
    }

    /** The 12-colour categorical palette; colour is a function of the tag name. */
    const TAG_PALETTE = [
      '#4c8dff', '#39b58a', '#e0803c', '#c65cd8', '#d9564f', '#3aa8c1',
      '#8a7bd8', '#7aa832', '#c98a2c', '#5f7fd6', '#b8536f', '#4b9e5f',
    ];

    /** @param {string} tag @returns {string} */
    function colorForTag(tag) {
      return TAG_PALETTE[hashString(String(tag)) % TAG_PALETTE.length];
    }

    /** Colour of a card: its first tag, or a neutral tone when it has none. */
    function colorForNode(node) {
      if (node && Array.isArray(node.tags) && node.tags.length > 0) return colorForTag(node.tags[0]);
      return '#8b93a7';
    }

    /** The kinds the extractor produces, in display order. */
    const KINDS = ['fact', 'procedure', 'decision', 'snippet', 'note'];
    const KIND_LABELS = {
      fact: '事实', procedure: '步骤', decision: '决策', snippet: '代码', note: '笔记',
    };

    /**
     * @param {string} kind
     * @returns {string}
     */
    function kindLabel(kind) {
      return KIND_LABELS[kind] || String(kind || '其他');
    }

    /**
     * Force-directed layout in a fixed world box.
     *
     * Repulsion uses a uniform spatial grid, so one iteration costs O(n + e)
     * instead of O(n²) — a 600-node vault still lays out in well under a second.
     * The result is deterministic for a given `seed`, so the graph does not
     * reshuffle on every re-render.
     *
     * @param {Array<object>} nodes
     * @param {Array<object>} edges
     * @param {{ width?: number, height?: number, seed?: number, iterations?: number }} [options]
     * @returns {Map<string, {x: number, y: number}>}
     */
    function layoutGraph(nodes, edges, options) {
      const opts = options || {};
      const width = opts.width || 1000;
      const height = opts.height || 700;
      const positions = new Map();
      const count = nodes.length;
      if (count === 0) return positions;
      const rand = mulberry32(opts.seed || 1);

      const xs = new Float64Array(count);
      const ys = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        // Golden-angle spiral: an even, deterministic starting spread that keeps
        // disconnected components from starting on top of each other.
        const angle = i * 2.399963229728653;
        const radius = Math.sqrt((i + 0.5) / count);
        xs[i] = width / 2 + Math.cos(angle) * radius * width * 0.38;
        ys[i] = height / 2 + Math.sin(angle) * radius * height * 0.38;
      }

      const index = new Map();
      for (let i = 0; i < count; i++) index.set(nodes[i].id, i);
      const links = [];
      for (const edge of edges || []) {
        const a = index.get(edge.source);
        const b = index.get(edge.target);
        if (a === undefined || b === undefined || a === b) continue;
        links.push([a, b, Math.min(3, Number(edge.weight) || 1)]);
      }

      const ideal = Math.sqrt((width * height) / Math.max(1, count)) * 0.62;
      const cell = ideal;
      const cols = Math.max(1, Math.ceil((width + cell) / cell));
      const rows = Math.max(1, Math.ceil((height + cell) / cell));
      const iterations = opts.iterations || Math.max(80, Math.min(260, Math.round(2600 / Math.sqrt(count))));

      const dx = new Float64Array(count);
      const dy = new Float64Array(count);
      for (let step = 0; step < iterations; step++) {
        dx.fill(0);
        dy.fill(0);
        const heat = 1 - step / iterations;

        const grid = new Map();
        for (let i = 0; i < count; i++) {
          const cx = Math.max(0, Math.min(cols - 1, Math.floor(xs[i] / cell)));
          const cy = Math.max(0, Math.min(rows - 1, Math.floor(ys[i] / cell)));
          const key = cy * cols + cx;
          let bucket = grid.get(key);
          if (bucket === undefined) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(i);
        }
        for (let i = 0; i < count; i++) {
          const cx = Math.max(0, Math.min(cols - 1, Math.floor(xs[i] / cell)));
          const cy = Math.max(0, Math.min(rows - 1, Math.floor(ys[i] / cell)));
          for (let gy = cy - 1; gy <= cy + 1; gy++) {
            if (gy < 0 || gy >= rows) continue;
            for (let gx = cx - 1; gx <= cx + 1; gx++) {
              if (gx < 0 || gx >= cols) continue;
              const bucket = grid.get(gy * cols + gx);
              if (bucket === undefined) continue;
              for (const j of bucket) {
                if (j <= i) continue;
                let ux = xs[i] - xs[j];
                let uy = ys[i] - ys[j];
                let dist2 = ux * ux + uy * uy;
                if (dist2 < 0.0001) {
                  ux = (rand() - 0.5) * 0.5;
                  uy = (rand() - 0.5) * 0.5;
                  dist2 = ux * ux + uy * uy + 0.0001;
                }
                if (dist2 > ideal * ideal * 9) continue;
                const dist = Math.sqrt(dist2);
                const force = ((ideal * ideal) / dist) * 0.012;
                const nx = ux / dist;
                const ny = uy / dist;
                dx[i] += nx * force;
                dy[i] += ny * force;
                dx[j] -= nx * force;
                dy[j] -= ny * force;
              }
            }
          }
        }
        for (const [a, b, weight] of links) {
          const ux = xs[a] - xs[b];
          const uy = ys[a] - ys[b];
          const dist = Math.max(0.001, Math.sqrt(ux * ux + uy * uy));
          const force = (dist - ideal) * 0.03 * weight;
          const nx = ux / dist;
          const ny = uy / dist;
          dx[a] -= nx * force;
          dy[a] -= ny * force;
          dx[b] += nx * force;
          dy[b] += ny * force;
        }
        const limit = Math.max(0.5, ideal * 0.5 * heat);
        for (let i = 0; i < count; i++) {
          dx[i] += (width / 2 - xs[i]) * 0.004;
          dy[i] += (height / 2 - ys[i]) * 0.004;
          xs[i] += Math.max(-limit, Math.min(limit, dx[i]));
          ys[i] += Math.max(-limit, Math.min(limit, dy[i]));
          xs[i] = Math.max(24, Math.min(width - 24, xs[i]));
          ys[i] = Math.max(24, Math.min(height - 24, ys[i]));
        }
      }

      for (let i = 0; i < count; i++) positions.set(nodes[i].id, { x: xs[i], y: ys[i] });
      return positions;
    }

    /**
     * Map a pointer position (CSS pixels, viewport-relative) onto the SVG's own
     * user-unit space.
     *
     * The canvas renders a fixed `0 0 world.width world.height` viewBox into an
     * element of arbitrary size with `preserveAspectRatio="xMidYMid meet"`, so
     * the content is uniformly scaled and letterboxed inside the element.
     * Treating one CSS pixel as one user unit — the obvious thing to write — is
     * only correct when the element happens to have exactly the viewBox's aspect
     * ratio; at any other size every marquee rectangle and node drag is offset
     * and mis-scaled.
     *
     * @param {{left: number, top: number, width: number, height: number}} rect element bounds
     * @param {{width: number, height: number}} world the viewBox size
     * @param {number} clientX pointer x in CSS pixels
     * @param {number} clientY pointer y in CSS pixels
     * @returns {{x: number, y: number}} SVG user units
     */
    function screenToSvgUnits(rect, world, clientX, clientY) {
      const scale = Math.min(rect.width / world.width, rect.height / world.height)
      const safeScale = scale > 0 && Number.isFinite(scale) ? scale : 1
      const offsetX = (rect.width - world.width * safeScale) / 2
      const offsetY = (rect.height - world.height * safeScale) / 2
      return {
        x: (clientX - rect.left - offsetX) / safeScale,
        y: (clientY - rect.top - offsetY) / safeScale,
      }
    }

    /**
     * Map a pointer position onto the graph's world coordinates, undoing both
     * the viewBox fit and the pan/zoom transform.
     * @param {{left: number, top: number, width: number, height: number}} rect element bounds
     * @param {{width: number, height: number}} world the viewBox size
     * @param {{k: number, x: number, y: number}} transform the pan/zoom transform
     * @param {number} clientX pointer x in CSS pixels
     * @param {number} clientY pointer y in CSS pixels
     * @returns {{x: number, y: number}}
     */
    function screenToWorld(rect, world, transform, clientX, clientY) {
      const units = screenToSvgUnits(rect, world, clientX, clientY)
      const k = transform.k > 0 && Number.isFinite(transform.k) ? transform.k : 1
      return { x: (units.x - transform.x) / k, y: (units.y - transform.y) / k }
    }

    /**
     * Recompute a pan/zoom transform so the point under the cursor stays put.
     * @param {{k: number, x: number, y: number}} transform current transform
     * @param {{x: number, y: number}} anchor anchor in SVG user units
     * @param {number} factor multiplicative zoom factor
     * @param {number} min minimum scale
     * @param {number} max maximum scale
     * @returns {{k: number, x: number, y: number}}
     */
    function zoomAround(transform, anchor, factor, min, max) {
      const k = Math.max(min, Math.min(max, transform.k * factor))
      const ratio = k / transform.k
      return {
        k,
        x: anchor.x - (anchor.x - transform.x) * ratio,
        y: anchor.y - (anchor.y - transform.y) * ratio,
      }
    }

    /**
     * Decide whether a pointer has moved far enough to count as a drag rather
     * than a click. A trackpad jitter of a pixel or two must not stop a node from
     * being selected.
     * @param {{startX?: number, startY?: number}} drag
     * @param {number} clientX
     * @param {number} clientY
     * @param {number} [threshold] in CSS pixels
     * @returns {boolean}
     */
    function exceedsDragThreshold(drag, clientX, clientY, threshold) {
      const limit = threshold === undefined ? 4 : threshold;
      const dx = (clientX || 0) - (drag.startX || 0);
      const dy = (clientY || 0) - (drag.startY || 0);
      return Math.abs(dx) + Math.abs(dy) >= limit;
    }

    /**
     * Node radius from degree, so hubs read as hubs.
     * @param {number} degree
     * @returns {number}
     */
    function nodeRadius(degree) {
      return 5 + Math.min(11, Math.sqrt(Math.max(0, degree)) * 3.1);
    }

    /**
     * Apply the legend and time-dimension filters.
     * @param {Array<object>} nodes
     * @param {Array<object>} edges
     * @param {{ enabledTags?: Set<string>|null, from?: number|null, to?: number|null, kinds?: Set<string>|null }} filters
     * @returns {{ nodes: Array<object>, edges: Array<object>, hidden: number }}
     */
    function filterGraph(nodes, edges, filters) {
      const f = filters || {};
      const enabled = f.enabledTags instanceof Set ? f.enabledTags : null;
      const kinds = f.kinds instanceof Set ? f.kinds : null;
      const from = typeof f.from === 'number' ? f.from : null;
      const to = typeof f.to === 'number' ? f.to : null;
      const visible = [];
      const kept = new Set();
      for (const node of nodes || []) {
        const tags = Array.isArray(node.tags) ? node.tags : [];
        // A node with no tags is always tag-visible: the legend can only speak
        // for tags that exist, and hiding untagged cards would be a surprise.
        if (enabled !== null && tags.length > 0 && !tags.some((tag) => enabled.has(tag))) continue;
        if (kinds !== null && !kinds.has(node.kind)) continue;
        if (from !== null && node.createdAt < from) continue;
        if (to !== null && node.createdAt > to) continue;
        visible.push(node);
        kept.add(node.id);
      }
      const visibleEdges = (edges || []).filter((edge) => kept.has(edge.source) && kept.has(edge.target));
      return { nodes: visible, edges: visibleEdges, hidden: (nodes || []).length - visible.length };
    }

    /**
     * Bucket cards into calendar months for the time histogram.
     * @param {Array<object>} nodes
     * @returns {Array<{key: string, label: string, count: number, start: number, end: number}>}
     */
    function monthHistogram(nodes) {
      const buckets = new Map();
      for (const node of nodes || []) {
        const date = new Date(node.createdAt || 0);
        if (Number.isNaN(date.getTime())) continue;
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
          const end = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() - 1;
          bucket = { key, label: key, count: 0, start, end };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
      }
      return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    }

    /**
     * Node ids whose centre falls inside a world-space rectangle.
     * @param {Map<string, {x: number, y: number}>} positions
     * @param {Array<object>} nodes
     * @param {{ x1: number, y1: number, x2: number, y2: number }} rect
     * @returns {string[]}
     */
    function nodesInRect(positions, nodes, rect) {
      const minX = Math.min(rect.x1, rect.x2);
      const maxX = Math.max(rect.x1, rect.x2);
      const minY = Math.min(rect.y1, rect.y2);
      const maxY = Math.max(rect.y1, rect.y2);
      const hits = [];
      for (const node of nodes || []) {
        const point = positions.get(node.id);
        if (point === undefined) continue;
        if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) hits.push(node.id);
      }
      return hits;
    }

    /**
     * @param {number} value
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    /**
     * @param {number} epoch
     * @returns {string} `YYYY-MM-DD`
     */
    function formatDay(epoch) {
      const date = new Date(epoch);
      if (Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    /**
     * @param {string} value `YYYY-MM-DD`
     * @returns {number|null}
     */
    function parseDay(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
      if (match === null) return null;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(date.getTime()) ? null : date.getTime();
    }

    /**
     * `YYYY-MM-DD hh:mm` for list rows.
     * @param {number} epoch
     * @returns {string}
     */
    function formatStamp(epoch) {
      const date = new Date(epoch);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${formatDay(epoch)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /* ---------------------------------------------------------------- *
     * Small presentational pieces
     * ---------------------------------------------------------------- */

    /**
     * @param {{ text: string, tone?: 'ok'|'error' }} props
     */
    function Toast(props) {
      if (props.toast === null || props.toast === undefined) return null;
      return React.createElement(
        'div',
        { className: 'dsb-toast' + (props.toast.tone === 'error' ? ' error' : '') },
        props.toast.text,
      );
    }

    /**
     * @param {{ open: boolean, title: string, children?: any, footer?: any, onClose: () => void }} props
     */
    function Modal(props) {
      if (!props.open) return null;
      return React.createElement(
        'div',
        { className: 'dsb-modal-backdrop', onClick: props.onClose },
        React.createElement(
          'div',
          { className: 'dsb-modal', onClick: (event) => event.stopPropagation() },
          React.createElement('div', { className: 'dsb-modal-title' }, props.title),
          React.createElement('div', { className: 'dsb-modal-body' }, props.children),
          React.createElement('div', { className: 'dsb-modal-footer' }, props.footer),
        ),
      );
    }

    /**
     * @param {{ label: string, active?: boolean, onClick: () => void, tone?: string }} props
     */
    function Button(props) {
      const classes = ['dsb-btn'];
      if (props.variant) classes.push('dsb-btn-' + props.variant);
      if (props.active) classes.push('active');
      return React.createElement(
        'button',
        { type: 'button', className: classes.join(' '), onClick: props.onClick, disabled: props.disabled === true, title: props.title || '' },
        props.label,
      );
    }

    /* ---------------------------------------------------------------- *
     * Library tab
     * ---------------------------------------------------------------- */

    /**
     * @param {{ notify: (text: string, tone?: string) => void, onChanged: () => void, tagIndex: Array<object> }} props
     */
    function LibraryTab(props) {
      // Destructured so the hooks below can depend on the CALLBACKS rather than
      // on the props object. `props` is a fresh literal on every parent render,
      // so depending on it rebuilt `load` every render, which re-fired its
      // effect, which on the error path called `notify` → new toast → parent
      // render → new `load` … a self-sustaining refetch loop.
      const notify = props.notify;
      const onChanged = props.onChanged;
      const [query, setQuery] = useState('');
      const [tag, setTag] = useState('');
      const [kind, setKind] = useState('');
      const [items, setItems] = useState([]);
      const [total, setTotal] = useState(0);
      const [busy, setBusy] = useState(false);
      const [selectedId, setSelectedId] = useState('');
      const [draft, setDraft] = useState(null);

      const load = useCallback(async () => {
        setBusy(true);
        const params = new URLSearchParams();
        if (query.trim() !== '') params.set('q', query.trim());
        if (tag !== '') params.set('tag', tag);
        if (kind !== '') params.set('kind', kind);
        params.set('limit', '300');
        const result = await api('/list?' + params.toString());
        setBusy(false);
        if (!result.ok) {
          notify(result.error || '读取知识库失败', 'error');
          return;
        }
        setItems(result.items || []);
        setTotal(result.total || 0);
      }, [query, tag, kind, notify]);

      useEffect(() => {
        const timer = setTimeout(() => { void load(); }, 180);
        return () => clearTimeout(timer);
      }, [load]);

      const open = useCallback(async (id) => {
        const result = await api('/card?id=' + encodeURIComponent(id));
        if (!result.ok) {
          notify(result.error || '读取知识卡失败', 'error');
          return;
        }
        setSelectedId(id);
        setDraft({
          id: result.card.id,
          title: result.card.title,
          kind: result.card.kind,
          tags: (result.card.tags || []).join(', '),
          body: result.card.body || '',
          pinned: result.card.pinned === true,
        });
      }, [notify]);

      const save = useCallback(async () => {
        if (draft === null) return;
        if (draft.title.trim() === '') {
          notify('标题不能为空', 'error');
          return;
        }
        const result = await api('/card', {
          method: 'POST',
          body: {
            id: draft.id,
            title: draft.title.trim(),
            kind: draft.kind,
            body: draft.body,
            tags: draft.tags.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
            pinned: draft.pinned,
          },
        });
        if (!result.ok) {
          notify(result.error || '保存失败', 'error');
          return;
        }
        notify('已保存');
        setSelectedId(result.card.id);
        await load();
        onChanged();
      }, [draft, load, notify, onChanged]);

      const remove = useCallback(async (id) => {
        const result = await api('/delete', { method: 'POST', body: { ids: [id] } });
        if (!result.ok) {
          notify(result.error || '删除失败', 'error');
          return;
        }
        notify('已删除');
        setDraft(null);
        setSelectedId('');
        await load();
        onChanged();
      }, [load, notify, onChanged]);

      const create = useCallback(() => {
        setSelectedId('');
        setDraft({ id: '', title: '', kind: 'fact', tags: '', body: '', pinned: false });
      }, []);

      const list = React.createElement(
        'div',
        { className: 'dsb-lib-list' },
        React.createElement(
          'div',
          { className: 'dsb-lib-list-head' },
          React.createElement('span', null, busy ? '加载中…' : `${total} 张`),
          React.createElement(Button, { label: '＋ 新建', onClick: create, variant: 'ghost' }),
        ),
        items.length === 0
          ? React.createElement('div', { className: 'dsb-empty' }, query.trim() !== '' ? '没有匹配的知识卡' : '知识库还是空的。对话结束后会自动沉淀，也可以在对话里让模型调用 brain_save。')
          : items.map((item) =>
              React.createElement(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'dsb-lib-item' + (item.id === selectedId ? ' active' : ''),
                  onClick: () => { void open(item.id); },
                },
                React.createElement('span', { className: 'dsb-lib-item-dot', style: { background: colorForNode(item) } }),
                React.createElement(
                  'span',
                  { className: 'dsb-lib-item-main' },
                  React.createElement('span', { className: 'dsb-lib-item-title' }, item.title),
                  React.createElement('span', { className: 'dsb-lib-item-meta' }, `${kindLabel(item.kind)} · ${formatDay(item.updatedAt)}${item.tags.length ? ' · #' + item.tags.slice(0, 3).join(' #') : ''}`),
                ),
              ),
            ),
      );

      const detail = draft === null
        ? React.createElement('div', { className: 'dsb-lib-detail dsb-empty' }, '选择左侧的知识卡查看与编辑，或点「＋ 新建」。')
        : React.createElement(
            'div',
            { className: 'dsb-lib-detail' },
            React.createElement('input', {
              className: 'dsb-input dsb-input-title',
              value: draft.title,
              placeholder: '标题（自含主语，脱离上下文也能看懂）',
              onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            }),
            React.createElement(
              'div',
              { className: 'dsb-row' },
              React.createElement(
                'select',
                { className: 'dsb-input', value: draft.kind, onChange: (event) => setDraft({ ...draft, kind: event.target.value }) },
                KINDS.map((item) => React.createElement('option', { key: item, value: item }, kindLabel(item))),
              ),
              React.createElement('input', {
                className: 'dsb-input',
                value: draft.tags,
                placeholder: '标签，逗号分隔',
                onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
              }),
            ),
            React.createElement('textarea', {
              className: 'dsb-input dsb-textarea',
              value: draft.body,
              placeholder: 'Markdown 正文',
              onChange: (event) => setDraft({ ...draft, body: event.target.value }),
            }),
            React.createElement(
              'div',
              { className: 'dsb-row dsb-row-end' },
              draft.id !== '' ? React.createElement(Button, { label: '删除', variant: 'danger', onClick: () => { void remove(draft.id); } }) : null,
              React.createElement(Button, { label: '保存', variant: 'primary', onClick: () => { void save(); } }),
            ),
          );

      return React.createElement(
        'div',
        { className: 'dsb-lib' },
        React.createElement(
          'div',
          { className: 'dsb-toolbar' },
          React.createElement('input', {
            className: 'dsb-input dsb-search',
            value: query,
            placeholder: '检索知识卡（支持中文）',
            onChange: (event) => setQuery(event.target.value),
          }),
          React.createElement(
            'select',
            { className: 'dsb-input dsb-select', value: kind, onChange: (event) => setKind(event.target.value) },
            React.createElement('option', { value: '' }, '全部类型'),
            KINDS.map((item) => React.createElement('option', { key: item, value: item }, kindLabel(item))),
          ),
          React.createElement(Button, { label: '刷新', variant: 'ghost', onClick: () => { void load(); } }),
        ),
        props.tagIndex.length > 0
          ? React.createElement(
              'div',
              { className: 'dsb-chips' },
              React.createElement(
                'button',
                { type: 'button', className: 'dsb-chip' + (tag === '' ? ' active' : ''), onClick: () => setTag('') },
                '全部标签',
              ),
              props.tagIndex.slice(0, 40).map((item) =>
                React.createElement(
                  'button',
                  {
                    key: item.name,
                    type: 'button',
                    className: 'dsb-chip' + (tag === item.name ? ' active' : ''),
                    onClick: () => setTag(tag === item.name ? '' : item.name),
                  },
                  React.createElement('span', { className: 'dsb-chip-dot', style: { background: colorForTag(item.name) } }),
                  `${item.name} ${item.count}`,
                ),
              ),
            )
          : null,
        React.createElement('div', { className: 'dsb-lib-body' }, list, detail),
      );
    }

    /* ---------------------------------------------------------------- *
     * Graph tab
     * ---------------------------------------------------------------- */

    const WORLD = { width: 1000, height: 700 };

    /**
     * @param {{ notify: (text: string, tone?: string) => void, onChanged: () => void }} props
     */
    function GraphTab(props) {
      const notify = props.notify;
      const onChanged = props.onChanged;
      const [graph, setGraph] = useState({ nodes: [], edges: [], tags: [] });
      const [busy, setBusy] = useState(true);
      const [enabledTags, setEnabledTags] = useState(null);
      const [enabledKinds, setEnabledKinds] = useState(null);
      const [range, setRange] = useState({ from: null, to: null });
      const [selected, setSelected] = useState(() => new Set());
      const [hovered, setHovered] = useState('');
      const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
      const [marquee, setMarquee] = useState(null);
      const [mergeOpen, setMergeOpen] = useState(false);
      const [mergeTitle, setMergeTitle] = useState('');
      const [showLabels, setShowLabels] = useState(true);

      const svgRef = useRef(null);
      const dragRef = useRef(null);
      const panRef = useRef(null);
      const positionsRef = useRef(null);
      const fileRef = useRef(null);

      const load = useCallback(async () => {
        setBusy(true);
        const result = await api('/graph');
        setBusy(false);
        if (!result.ok) {
          notify(result.error || '读取知识图谱失败', 'error');
          return;
        }
        setGraph({ nodes: result.nodes || [], edges: result.edges || [], tags: result.tags || [] });
      }, [notify]);

      useEffect(() => { void load(); }, [load]);

      // The layout is recomputed only when the graph's identity changes, so
      // panning, selecting, dragging and filtering never reshuffle it.
      const signature = useMemo(
        () => `${graph.nodes.map((node) => node.id).join('|')}#${graph.edges.map((edge) => edge.key).join('|')}`,
        [graph],
      );
      const basePositions = useMemo(
        () => layoutGraph(graph.nodes, graph.edges, { seed: hashString(signature) || 1, width: WORLD.width, height: WORLD.height }),
        [signature],
      );
      // Attach the layout during render rather than in an effect: an effect runs
      // after the first paint, which would leave the canvas empty until some
      // unrelated state change happened to trigger a second render.
      if (positionsRef.current === null || positionsRef.current.signature !== signature) {
        positionsRef.current = { signature, positions: new Map(basePositions) };
      }

      const enabledTagSet = useMemo(() => {
        if (enabledTags !== null) return enabledTags;
        return new Set(graph.tags.map((tag) => tag.name));
      }, [enabledTags, graph.tags]);
      const enabledKindSet = useMemo(() => enabledKinds, [enabledKinds]);

      const view = useMemo(
        () => filterGraph(graph.nodes, graph.edges, {
          enabledTags: enabledTagSet,
          kinds: enabledKindSet,
          from: range.from,
          to: range.to,
        }),
        [graph, enabledTagSet, enabledKindSet, range],
      );

      const histogram = useMemo(() => monthHistogram(graph.nodes), [graph.nodes]);

      const positions = positionsRef.current.positions;

      const visibleNodes = view.nodes;
      const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

      const selectedNodes = useMemo(
        () => graph.nodes.filter((node) => selected.has(node.id)),
        [graph, selected],
      );

      /* --- pointer handling --------------------------------------- */

      const toWorld = useCallback((event) => {
        const svg = svgRef.current;
        if (svg === null) return { x: 0, y: 0 };
        return screenToWorld(svg.getBoundingClientRect(), WORLD, transform, event.clientX, event.clientY);
      }, [transform]);

      const onBackgroundPointerDown = useCallback((event) => {
        if (event.button === 1 || event.shiftKey || event.altKey) {
          panRef.current = { startX: event.clientX, startY: event.clientY, originX: transform.x, originY: transform.y };
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (event.button !== 0) return;
        const point = toWorld(event);
        setMarquee({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        event.currentTarget.setPointerCapture(event.pointerId);
      }, [toWorld, transform]);

      const onBackgroundPointerMove = useCallback((event) => {
        if (panRef.current !== null) {
          setTransform({
            k: transform.k,
            x: panRef.current.originX + (event.clientX - panRef.current.startX),
            y: panRef.current.originY + (event.clientY - panRef.current.startY),
          });
          return;
        }
        if (marquee === null) return;
        const point = toWorld(event);
        setMarquee({ ...marquee, x2: point.x, y2: point.y });
      }, [marquee, toWorld, transform]);

      const onBackgroundPointerUp = useCallback((event) => {
        if (panRef.current !== null) {
          panRef.current = null;
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
          return;
        }
        if (marquee === null) return;
        const point = toWorld(event);
        const rect = { x1: marquee.x1, y1: marquee.y1, x2: point.x, y2: point.y };
        const moved = Math.abs(rect.x2 - rect.x1) > 3 || Math.abs(rect.y2 - rect.y1) > 3;
        setMarquee(null);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        if (!moved) {
          if (!event.shiftKey) setSelected(new Set());
          return;
        }
        const hits = nodesInRect(positions, visibleNodes, rect);
        setSelected((previous) => {
          const next = event.shiftKey ? new Set(previous) : new Set();
          for (const id of hits) next.add(id);
          return next;
        });
      }, [marquee, positions, toWorld, visibleNodes]);

      const onNodePointerDown = useCallback((event, id) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const point = toWorld(event);
        const anchor = positions.get(id) || { x: point.x, y: point.y };
        dragRef.current = {
          id,
          offsetX: anchor.x - point.x,
          offsetY: anchor.y - point.y,
          moved: false,
          startX: event.clientX,
          startY: event.clientY,
        };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
      }, [positions, toWorld]);

      const onNodePointerMove = useCallback((event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        // A trackpad jitter of a pixel or two between press and release is a
        // click, not a drag. Without this threshold `moved` flipped on any
        // pointermove and the click-to-select branch below was unreachable.
        if (!drag.moved) {
          if (!exceedsDragThreshold(drag, event.clientX, event.clientY)) return;
          drag.moved = true;
        }
        const point = toWorld(event);
        positions.set(drag.id, { x: point.x + drag.offsetX, y: point.y + drag.offsetY });
        setTransform((previous) => ({ ...previous }));
      }, [positions, toWorld]);

      const onNodePointerUp = useCallback((event, id) => {
        const drag = dragRef.current;
        dragRef.current = null;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
        if (drag !== null && drag.moved) return;
        setSelected((previous) => {
          const next = new Set(previous);
          if (event.shiftKey) {
            if (next.has(id)) next.delete(id);
            else next.add(id);
          } else {
            next.clear();
            next.add(id);
          }
          return next;
        });
      }, []);

      const onWheel = useCallback((event) => {
        const svg = svgRef.current;
        if (svg === null) return;
        // The anchor must be in SVG user units: using raw element pixels would
        // make zoom drift whenever the element is letterboxed.
        const anchor = screenToSvgUnits(svg.getBoundingClientRect(), WORLD, event.clientX, event.clientY);
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        setTransform((previous) => zoomAround(previous, anchor, factor, 0.2, 5));
      }, []);

      // Zooming must not also scroll the settings panel. React attaches wheel
      // listeners as passive, so `preventDefault()` inside the `onWheel` prop is
      // ignored; a native non-passive listener is the only way to claim the
      // gesture. `onWheel` uses a functional state update, so this binds once.
      useEffect(() => {
        const svg = svgRef.current;
        if (svg === null || typeof svg.addEventListener !== 'function') return undefined;
        const handler = (event) => {
          if (event.cancelable !== false) event.preventDefault();
          onWheel(event);
        };
        svg.addEventListener('wheel', handler, { passive: false });
        return () => svg.removeEventListener('wheel', handler);
      }, [onWheel]);

      const resetView = useCallback(() => setTransform({ k: 1, x: 0, y: 0 }), []);

      /* --- actions ------------------------------------------------ */

      const toggleTag = useCallback((name) => {
        setEnabledTags((previous) => {
          const next = new Set(previous === null ? graph.tags.map((tag) => tag.name) : previous);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
      }, [graph.tags]);

      const toggleKind = useCallback((kind) => {
        setEnabledKinds((previous) => {
          const all = new Set(graph.nodes.map((node) => node.kind));
          const next = new Set(previous === null ? all : previous);
          if (next.has(kind)) next.delete(kind);
          else next.add(kind);
          return next;
        });
      }, [graph.nodes]);

      const focusMonth = useCallback((bucket) => {
        setRange((previous) => (previous.from === bucket.start && previous.to === bucket.end
          ? { from: null, to: null }
          : { from: bucket.start, to: bucket.end }));
      }, []);

      const doMerge = useCallback(async () => {
        const ids = [...selected];
        if (ids.length < 2) {
          notify('至少选中两张知识卡才能合并', 'error');
          return;
        }
        const result = await api('/merge', { method: 'POST', body: { ids, title: mergeTitle.trim() || undefined } });
        if (!result.ok) {
          notify(result.error || '合并失败', 'error');
          return;
        }
        notify(`已合并 ${ids.length} 张知识卡`);
        setMergeOpen(false);
        setMergeTitle('');
        setSelected(new Set([result.card.id]));
        await load();
        onChanged();
      }, [selected, mergeTitle, load, notify, onChanged]);

      const doDelete = useCallback(async () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        const result = await api('/delete', { method: 'POST', body: { ids } });
        if (!result.ok) {
          notify(result.error || '删除失败', 'error');
          return;
        }
        notify(`已删除 ${result.deleted.length} 张知识卡`);
        setSelected(new Set());
        await load();
        onChanged();
      }, [selected, load, notify, onChanged]);

      const doExport = useCallback(async () => {
        const ids = [...selected];
        const query = ids.length > 0 ? `?ids=${encodeURIComponent(ids.join(','))}&download=1` : '?download=1';
        try {
          const response = await fetch(BASE + '/export' + query, { cache: 'no-store' });
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `second-brain-${formatDay(Date.now())}.json`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
          notify(`已导出${ids.length > 0 ? `选中的 ${ids.length} 张` : '全部'}`);
        } catch (error) {
          notify(String((error && error.message) || error), 'error');
        }
      }, [selected, notify]);

      const doImport = useCallback(async (event) => {
        const file = event.target.files && event.target.files[0];
        if (file === undefined) return;
        try {
          const text = await file.text();
          const parsed = JSON.parse(text);
          const result = await api('/import', { method: 'POST', body: { bundle: parsed, mode: 'merge' } });
          if (!result.ok) {
            notify(result.error || '导入失败', 'error');
            return;
          }
          notify(`导入完成：新增 ${result.imported} 张，跳过 ${result.skipped} 张`);
          await load();
          onChanged();
        } catch (error) {
          notify(`导入失败：${String((error && error.message) || error)}`, 'error');
        } finally {
          if (fileRef.current !== null) fileRef.current.value = '';
        }
      }, [load, notify, onChanged]);

      /* --- render ------------------------------------------------- */

      const degree = useMemo(() => {
        const map = new Map();
        for (const edge of view.edges) {
          map.set(edge.source, (map.get(edge.source) || 0) + 1);
          map.set(edge.target, (map.get(edge.target) || 0) + 1);
        }
        return map;
      }, [view.edges]);

      const edgeElements = view.edges.map((edge) => {
        const a = positions.get(edge.source);
        const b = positions.get(edge.target);
        if (a === undefined || b === undefined) return null;
        const active = selected.has(edge.source) && selected.has(edge.target);
        return React.createElement('line', {
          key: edge.key,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: active ? 'var(--dsw-alias-brand-primary, #4c8dff)' : edge.type === 'link' ? '#8b93a7' : '#c9cede',
          strokeWidth: active ? 2.4 : Math.min(2.2, 0.7 + edge.weight * 0.35),
          strokeDasharray: edge.type === 'link' ? undefined : '4 3',
          opacity: active ? 1 : 0.5,
        });
      });

      const nodeElements = visibleNodes.map((node) => {
        const point = positions.get(node.id);
        if (point === undefined) return null;
        const radius = nodeRadius(degree.get(node.id) || 0);
        const isSelected = selected.has(node.id);
        const isHovered = hovered === node.id;
        return React.createElement(
          'g',
          {
            key: node.id,
            className: 'dsb-node',
            transform: `translate(${point.x},${point.y})`,
            onPointerDown: (event) => onNodePointerDown(event, node.id),
            onPointerMove: onNodePointerMove,
            onPointerUp: (event) => onNodePointerUp(event, node.id),
            onPointerEnter: () => setHovered(node.id),
            onPointerLeave: () => setHovered((previous) => (previous === node.id ? '' : previous)),
          },
          React.createElement('circle', {
            r: radius + (isSelected ? 3.5 : 0),
            fill: colorForNode(node),
            stroke: isSelected ? 'var(--dsw-alias-brand-primary, #4c8dff)' : isHovered ? '#6b7280' : 'rgba(0,0,0,0.18)',
            strokeWidth: isSelected ? 3 : 1,
            opacity: 0.92,
          }),
          showLabels && (isSelected || isHovered || radius > 11)
            ? React.createElement(
                'text',
                { className: 'dsb-node-label', y: radius + 12, textAnchor: 'middle' },
                node.title.length > 16 ? `${node.title.slice(0, 16)}…` : node.title,
              )
            : null,
        );
      });

      const marqueeRect = marquee === null
        ? null
        : React.createElement('rect', {
            x: Math.min(marquee.x1, marquee.x2),
            y: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
            fill: 'rgba(76,141,255,0.12)',
            stroke: 'var(--dsw-alias-brand-primary, #4c8dff)',
            strokeWidth: 1,
            strokeDasharray: '4 3',
          });

      const hoveredNode = hovered === '' ? null : byId.get(hovered);

      const legend = React.createElement(
        'div',
        { className: 'dsb-legend' },
        React.createElement('div', { className: 'dsb-legend-title' }, '图例'),
        React.createElement(
          'div',
          { className: 'dsb-legend-actions' },
          React.createElement(Button, {
            label: '全选',
            variant: 'ghost',
            onClick: () => setEnabledTags(new Set(graph.tags.map((tag) => tag.name))),
          }),
          React.createElement(Button, { label: '清空', variant: 'ghost', onClick: () => setEnabledTags(new Set()) }),
          React.createElement(Button, { label: '反选', variant: 'ghost', onClick: () => setEnabledTags((previous) => {
            const current = previous === null ? new Set(graph.tags.map((tag) => tag.name)) : previous;
            return new Set(graph.tags.map((tag) => tag.name).filter((name) => !current.has(name)));
          }) }),
        ),
        graph.tags.length === 0
          ? React.createElement('div', { className: 'dsb-empty dsb-legend-empty' }, '暂无标签')
          : graph.tags.slice(0, 120).map((tag) =>
              React.createElement(
                'button',
                {
                  key: tag.name,
                  type: 'button',
                  className: 'dsb-legend-row' + (enabledTagSet.has(tag.name) ? '' : ' off'),
                  onClick: () => toggleTag(tag.name),
                  title: tag.name,
                },
                React.createElement('span', { className: 'dsb-legend-dot', style: { background: colorForTag(tag.name) } }),
                React.createElement('span', { className: 'dsb-legend-name' }, tag.name),
                React.createElement('span', { className: 'dsb-legend-count' }, String(tag.count)),
              ),
            ),
        React.createElement('div', { className: 'dsb-legend-title' }, '类型'),
        KINDS.filter((kind) => graph.nodes.some((node) => node.kind === kind)).map((kind) =>
          React.createElement(
            'button',
            {
              key: kind,
              type: 'button',
              className: 'dsb-legend-row' + (enabledKindSet === null || enabledKindSet.has(kind) ? '' : ' off'),
              onClick: () => toggleKind(kind),
            },
            React.createElement('span', { className: 'dsb-legend-dot', style: { background: '#8b93a7' } }),
            React.createElement('span', { className: 'dsb-legend-name' }, kindLabel(kind)),
            React.createElement('span', { className: 'dsb-legend-count' }, String(graph.nodes.filter((node) => node.kind === kind).length)),
          ),
        ),
      );

      const timePanel = React.createElement(
        'div',
        { className: 'dsb-time' },
        React.createElement(
          'div',
          { className: 'dsb-time-head' },
          React.createElement('span', null, '时间维'),
          React.createElement('span', { className: 'dsb-time-range' },
            `${range.from === null ? '最早' : formatDay(range.from)} → ${range.to === null ? '最新' : formatDay(range.to)}`),
          React.createElement(Button, { label: '重置', variant: 'ghost', onClick: () => setRange({ from: null, to: null }) }),
        ),
        React.createElement(
          'div',
          { className: 'dsb-histogram' },
          histogram.length === 0
            ? React.createElement('div', { className: 'dsb-empty dsb-histogram-empty' }, '暂无数据')
            : histogram.map((bucket) => {
                const max = Math.max(...histogram.map((item) => item.count));
                const active = range.from === bucket.start && range.to === bucket.end;
                return React.createElement(
                  'button',
                  {
                    key: bucket.key,
                    type: 'button',
                    className: 'dsb-bar' + (active ? ' active' : ''),
                    title: `${bucket.label}：${bucket.count} 张`,
                    onClick: () => focusMonth(bucket),
                  },
                  React.createElement('span', {
                    className: 'dsb-bar-fill',
                    style: { height: `${Math.max(6, Math.round((bucket.count / max) * 100))}%` },
                  }),
                  React.createElement('span', { className: 'dsb-bar-label' }, bucket.label.slice(2)),
                );
              }),
        ),
        React.createElement(
          'div',
          { className: 'dsb-time-inputs' },
          React.createElement('input', {
            className: 'dsb-input dsb-date',
            type: 'date',
            value: range.from === null ? '' : formatDay(range.from),
            onChange: (event) => setRange((previous) => ({ ...previous, from: parseDay(event.target.value) })),
          }),
          React.createElement('span', { className: 'dsb-time-sep' }, '至'),
          React.createElement('input', {
            className: 'dsb-input dsb-date',
            type: 'date',
            value: range.to === null ? '' : formatDay(range.to),
            onChange: (event) => setRange((previous) => ({ ...previous, to: parseDay(event.target.value) })),
          }),
        ),
      );

      const selectionPanel = React.createElement(
        'div',
        { className: 'dsb-selection' },
        React.createElement(
          'div',
          { className: 'dsb-selection-head' },
          React.createElement('span', null, `已选 ${selected.size} 张`),
        ),
        React.createElement(
          'div',
          { className: 'dsb-selection-actions' },
          React.createElement(Button, { label: '合并', variant: 'primary', disabled: selected.size < 2, onClick: () => {
            const first = selectedNodes[0];
            setMergeTitle(first === undefined ? '' : first.title);
            setMergeOpen(true);
          } }),
          React.createElement(Button, { label: '导出选中', variant: 'ghost', disabled: selected.size === 0, onClick: () => { void doExport(); } }),
          React.createElement(Button, { label: '删除', variant: 'danger', disabled: selected.size === 0, onClick: () => { void doDelete(); } }),
          React.createElement(Button, { label: '清空选择', variant: 'ghost', disabled: selected.size === 0, onClick: () => setSelected(new Set()) }),
        ),
        selectedNodes.length > 0
          ? React.createElement(
              'div',
              { className: 'dsb-selection-list' },
              selectedNodes.slice(0, 12).map((node) =>
                React.createElement('div', { key: node.id, className: 'dsb-selection-row', title: node.title }, node.title),
              ),
              selectedNodes.length > 12 ? React.createElement('div', { className: 'dsb-selection-row muted' }, `…… 还有 ${selectedNodes.length - 12} 张`) : null,
            )
          : null,
      );

      const details = React.createElement(
        'div',
        { className: 'dsb-details' },
        hoveredNode === null
          ? React.createElement('div', { className: 'dsb-empty' }, '把指针移到节点上查看详情；拖拽空白处框选，Shift+拖拽平移，滚轮缩放。')
          : React.createElement(
              'div',
              null,
              React.createElement('div', { className: 'dsb-details-title' }, hoveredNode.title),
              React.createElement('div', { className: 'dsb-details-meta' },
                `${kindLabel(hoveredNode.kind)} · ${formatStamp(hoveredNode.createdAt)} · ${hoveredNode.bodyLength} 字 · 度 ${degree.get(hoveredNode.id) || 0}`),
              React.createElement('div', { className: 'dsb-details-summary' }, hoveredNode.summary),
              hoveredNode.tags.length > 0
                ? React.createElement('div', { className: 'dsb-chips' }, hoveredNode.tags.map((tag) =>
                    React.createElement('span', { key: tag, className: 'dsb-chip static' },
                      React.createElement('span', { className: 'dsb-chip-dot', style: { background: colorForTag(tag) } }), tag)))
                : null,
            ),
      );

      return React.createElement(
        'div',
        { className: 'dsb-graph' },
        React.createElement(
          'div',
          { className: 'dsb-toolbar' },
          React.createElement('span', { className: 'dsb-toolbar-info' },
            busy ? '加载中…' : `${view.nodes.length} / ${graph.nodes.length} 个节点 · ${view.edges.length} 条关联`),
          React.createElement(Button, { label: showLabels ? '隐藏标签' : '显示标签', variant: 'ghost', onClick: () => setShowLabels(!showLabels) }),
          React.createElement(Button, { label: '重置视图', variant: 'ghost', onClick: resetView }),
          React.createElement(Button, { label: '重新布局', variant: 'ghost', onClick: () => {
            positionsRef.current = {
              signature,
              positions: layoutGraph(graph.nodes, graph.edges, {
                seed: (hashString(signature) + Math.floor(Math.random() * 100000)) || 1,
                width: WORLD.width,
                height: WORLD.height,
              }),
            };
            setTransform((previous) => ({ ...previous }));
          } }),
          React.createElement(Button, { label: '导出全部', variant: 'ghost', onClick: () => { void doExport(); } }),
          React.createElement(Button, { label: '导入', variant: 'ghost', onClick: () => { if (fileRef.current !== null) fileRef.current.click(); } }),
          React.createElement(Button, { label: '刷新', variant: 'ghost', onClick: () => { void load(); } }),
          React.createElement('input', {
            ref: fileRef,
            type: 'file',
            accept: '.json,application/json',
            style: { display: 'none' },
            onChange: (event) => { void doImport(event); },
          }),
        ),
        React.createElement(
          'div',
          { className: 'dsb-graph-body' },
          React.createElement(
            'div',
            { className: 'dsb-canvas-wrap' },
            React.createElement(
              'svg',
              {
                ref: svgRef,
                className: 'dsb-canvas',
                viewBox: `0 0 ${WORLD.width} ${WORLD.height}`,
                preserveAspectRatio: 'xMidYMid meet',
                onPointerDown: onBackgroundPointerDown,
                onPointerMove: onBackgroundPointerMove,
                onPointerUp: onBackgroundPointerUp,
                onPointerCancel: onBackgroundPointerUp,
              },
              React.createElement(
                'g',
                { transform: `translate(${transform.x},${transform.y}) scale(${transform.k})` },
                React.createElement('g', { className: 'dsb-edges' }, edgeElements),
                React.createElement('g', { className: 'dsb-nodes' }, nodeElements),
                marqueeRect,
              ),
            ),
            view.nodes.length === 0
              ? React.createElement('div', { className: 'dsb-canvas-overlay' },
                  graph.nodes.length === 0 ? '知识库还是空的，先去「知识库」标签页新建或让模型保存几条。' : '当前筛选下没有节点，试试放宽图例或时间范围。')
              : null,
          ),
          React.createElement('div', { className: 'dsb-side' }, legend, timePanel, selectionPanel, details),
        ),
        React.createElement(
          Modal,
          {
            open: mergeOpen,
            title: '合并选中的知识卡',
            onClose: () => setMergeOpen(false),
            footer: React.createElement(
              'div',
              { className: 'dsb-row dsb-row-end' },
              React.createElement(Button, { label: '取消', variant: 'ghost', onClick: () => setMergeOpen(false) }),
              React.createElement(Button, { label: '合并', variant: 'primary', onClick: () => { void doMerge(); } }),
            ),
          },
          React.createElement('div', { className: 'dsb-modal-hint' }, `将把选中的 ${selected.size} 张知识卡合并为一张：标签、关联与来源取并集，正文按原卡拼接并去掉完全重复的段落，创建时间保留最早的一张。`),
          React.createElement('input', {
            className: 'dsb-input',
            value: mergeTitle,
            placeholder: '合并后的标题',
            onChange: (event) => setMergeTitle(event.target.value),
          }),
        ),
      );
    }

    /* ---------------------------------------------------------------- *
     * Settings tab
     * ---------------------------------------------------------------- */

    /**
     * @param {{ notify: (text: string, tone?: string) => void, onChanged: () => void, config: object, stats: object }} props
     */
    function SettingsTab(props) {
      const notify = props.notify;
      const onChanged = props.onChanged;
      const [edited, setEdited] = useState(null);
      const [gitOutput, setGitOutput] = useState('');
      const [busy, setBusy] = useState(false);

      // The host config arrives asynchronously, so the working copy is DERIVED
      // from props until the user edits something. Syncing it through an effect
      // would render an empty form first and then a full one, which is both a
      // wasted frame and a state that is briefly inconsistent with the props.
      const form = edited !== null ? edited : (props.config === null || props.config === undefined ? null : { ...props.config });
      if (form === null) return React.createElement('div', { className: 'dsb-empty' }, '加载中…');

      const field = (key, label, hint, type) => React.createElement(
        'label',
        { className: 'dsb-field' },
        React.createElement('span', { className: 'dsb-field-label' }, label),
        type === 'checkbox'
          ? React.createElement('input', { type: 'checkbox', checked: form[key] === true, onChange: (event) => setEdited({ ...form, [key]: event.target.checked }) })
          : React.createElement('input', {
              className: 'dsb-input',
              type: type || 'text',
              value: form[key] === undefined || form[key] === null ? '' : String(form[key]),
              onChange: (event) => setEdited({ ...form, [key]: type === 'number' ? Number(event.target.value) : event.target.value }),
            }),
        hint ? React.createElement('span', { className: 'dsb-field-hint' }, hint) : null,
      );

      const save = async () => {
        setBusy(true);
        const patch = {};
        for (const key of ['vault', 'capture', 'minChars', 'maxCardChars', 'tagsLimit', 'dedupeThreshold', 'relatedThreshold', 'autoMergeDuplicates', 'linkRelated', 'gitAutoCommit', 'writeIndexFile', 'llmProvider', 'llmModel', 'minCodeLines', 'minCodeChars', 'heuristicFallback']) {
          if (form[key] !== undefined) patch[key] = form[key];
        }
        const result = await api('/config', { method: 'POST', body: { patch } });
        setBusy(false);
        if (!result.ok) {
          notify(result.error || '保存配置失败', 'error');
          return;
        }
        notify('配置已保存');
        setEdited({ ...result.config });
        onChanged();
      };

      const git = async (action) => {
        setBusy(true);
        const result = await api('/git', { method: 'POST', body: { action } });
        setBusy(false);
        setGitOutput(result.output || result.error || '');
        if (!result.ok) notify(result.error || 'git 操作失败', 'error');
        else notify('git 操作完成');
      };

      return React.createElement(
        'div',
        { className: 'dsb-settings' },
        React.createElement('div', { className: 'dsb-settings-group' },
          React.createElement('div', { className: 'dsb-settings-title' }, '存储'),
          field('vault', '知识库目录', '每张知识卡是一个 Markdown 文件，放在该目录的 cards/ 下。可用 git 管理这个目录。'),
          React.createElement('div', { className: 'dsb-settings-stats' },
            `当前：${props.stats.cards || 0} 张卡 · ${props.stats.tags || 0} 个标签 · ${props.stats.links || 0} 条关联 · ${props.stats.bytes || 0} 字`),
        ),
        React.createElement('div', { className: 'dsb-settings-group' },
          React.createElement('div', { className: 'dsb-settings-title' }, '自动沉淀'),
          React.createElement('label', { className: 'dsb-field' },
            React.createElement('span', { className: 'dsb-field-label' }, '采集策略'),
            React.createElement('select', {
              className: 'dsb-input',
              value: form.capture,
              onChange: (event) => setEdited({ ...form, capture: event.target.value }),
            },
              React.createElement('option', { value: 'heuristic' }, '启发式（默认，不调用模型，确定性提取）'),
              React.createElement('option', { value: 'llm' }, '模型提炼（调用当前默认模型，失败自动回退启发式）'),
              React.createElement('option', { value: 'off' }, '关闭自动采集（仍可用 brain_save 手动保存）'),
            ),
            React.createElement('span', { className: 'dsb-field-hint' }, '对话每轮结束时触发，异步进行，不会拖慢或影响对话。'),
          ),
          field('minChars', '最小正文长度', '助手回复短于该长度就不生成知识卡（代码片段仍会单独成卡）。', 'number'),
          field('minCodeLines', '代码片段最少行数', '少于该行数且字符数也不足的代码块会被忽略。', 'number'),
          field('minCodeChars', '代码片段最少字符数', '与行数取「或」关系。', 'number'),
          field('maxCardChars', '知识卡正文上限', '超出部分截断，避免单卡过长。', 'number'),
          field('tagsLimit', '自动标签数量', '每张卡最多几个标签。', 'number'),
        ),
        React.createElement('div', { className: 'dsb-settings-group' },
          React.createElement('div', { className: 'dsb-settings-title' }, '去重'),
          React.createElement('div', { className: 'dsb-field-hint' }, '去重分两级：先用 MinHash 签名快速筛掉明显无关的卡，再对候选做精确的词元集合比较（Jaccard + 包含度）。'),
          field('dedupeThreshold', '重复阈值', '0.15 ~ 0.999，越大越严格。默认 0.42：中文卡片里同主题不同内容的相似度通常低于 0.12，同一知识换个说法大约在 0.29~0.57。', 'number'),
          field('relatedThreshold', '关联阈值', '达到该相似度就互相建立关联边。默认 0.18。', 'number'),
          React.createElement('label', { className: 'dsb-field dsb-field-inline' },
            React.createElement('input', { type: 'checkbox', checked: form.autoMergeDuplicates === true, onChange: (event) => setEdited({ ...form, autoMergeDuplicates: event.target.checked }) }),
            React.createElement('span', null, '近似重复自动合并（关闭则新建并互相链接）'),
          ),
          React.createElement('label', { className: 'dsb-field dsb-field-inline' },
            React.createElement('input', { type: 'checkbox', checked: form.linkRelated === true, onChange: (event) => setEdited({ ...form, linkRelated: event.target.checked }) }),
            React.createElement('span', null, '为相关卡片自动建立关联'),
          ),
        ),
        React.createElement('div', { className: 'dsb-settings-group' },
          React.createElement('div', { className: 'dsb-settings-title' }, '模型不可用时怎么办'),
          React.createElement('div', { className: 'dsb-field-hint' },
            '「模型提炼」模式下，如果模型调用失败或回答无法解析：默认跳过本轮，知识库保持干净；打开下面的开关则会改用确定性提取器兜底——它总能在长回复里找到东西（以你的消息为标题的卡，加上每个代码块一张），这也正是噪声的来源。'),
          React.createElement('label', { className: 'dsb-field dsb-field-inline' },
            React.createElement('input', { type: 'checkbox', checked: form.heuristicFallback === true, onChange: (event) => setEdited({ ...form, heuristicFallback: event.target.checked }) }),
            React.createElement('span', null, '模型不可用时回退到启发式提取（默认关闭）'),
          ),
        ),
        React.createElement('div', { className: 'dsb-settings-group' },
          React.createElement('div', { className: 'dsb-settings-title' }, 'git'),
          React.createElement('label', { className: 'dsb-field dsb-field-inline' },
            React.createElement('input', { type: 'checkbox', checked: form.gitAutoCommit === true, onChange: (event) => setEdited({ ...form, gitAutoCommit: event.target.checked }) }),
            React.createElement('span', null, '每次写入后自动 git 提交'),
          ),
          React.createElement('label', { className: 'dsb-field dsb-field-inline' },
            React.createElement('input', { type: 'checkbox', checked: form.writeIndexFile === true, onChange: (event) => setEdited({ ...form, writeIndexFile: event.target.checked }) }),
            React.createElement('span', null, '同时生成 index.json（便于外部工具读取）'),
          ),
          React.createElement('div', { className: 'dsb-row' },
            React.createElement(Button, { label: 'git init', variant: 'ghost', onClick: () => { void git('init'); } }),
            React.createElement(Button, { label: '提交当前变更', variant: 'ghost', onClick: () => { void git('commit'); } }),
            React.createElement(Button, { label: '查看状态', variant: 'ghost', onClick: () => { void git('status'); } }),
          ),
          gitOutput !== '' ? React.createElement('pre', { className: 'dsb-git-output' }, gitOutput) : null,
        ),
        React.createElement('div', { className: 'dsb-settings-group' },
          React.createElement('div', { className: 'dsb-settings-title' }, '模型提炼（可选）'),
          field('llmProvider', 'provider', '留空则沿用当前默认模型。'),
          field('llmModel', 'model', '留空则沿用当前默认模型。'),
        ),
        React.createElement('div', { className: 'dsb-row dsb-row-end' },
          React.createElement(Button, { label: busy ? '处理中…' : '保存配置', variant: 'primary', onClick: () => { void save(); } }),
          React.createElement(Button, { label: '重新索引', variant: 'ghost', onClick: async () => {
            const result = await api('/reindex', { method: 'POST', body: {} });
            notify(result.ok ? `已重新索引：${result.stats.cards} 张` : (result.error || '重新索引失败'), result.ok ? 'ok' : 'error');
            onChanged();
          } }),
        ),
      );
    }

    /* ---------------------------------------------------------------- *
     * Page
     * ---------------------------------------------------------------- */

    const TABS = [
      { id: 'library', label: '知识库' },
      { id: 'graph', label: '知识图谱' },
      { id: 'settings', label: '设置' },
    ];

    /**
     * @param {{ close?: () => void }} props
     */
    function BrainPage(props) {
      const [tab, setTab] = useState('library');
      const [overview, setOverview] = useState(null);
      const [toast, setToast] = useState(null);
      const toastTimer = useRef(null);

      const notify = useCallback((text, tone) => {
        setToast({ text, tone: tone || 'ok' });
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 2600);
      }, []);

      useEffect(() => () => { if (toastTimer.current !== null) clearTimeout(toastTimer.current); }, []);

      const reload = useCallback(async () => {
        const result = await api('/overview');
        if (!result.ok) {
          notify(result.error || '读取第二大脑失败', 'error');
          return;
        }
        setOverview(result);
      }, [notify]);

      useEffect(() => { void reload(); }, [reload]);

      const config = overview === null ? null : overview.config;
      const stats = overview === null ? { cards: 0, tags: 0, links: 0, bytes: 0 } : overview.stats;
      const tags = overview === null ? [] : overview.tags;

      return React.createElement(
        'div',
        { className: 'dsb-page' },
        React.createElement(
          'div',
          { className: 'dsb-head' },
          React.createElement('div', { className: 'dsb-head-title' }, '第二大脑'),
          React.createElement('div', { className: 'dsb-head-sub' },
            overview === null ? '加载中…' : `${stats.cards} 张知识卡 · ${stats.tags} 个标签 · ${config.vault}`),
          React.createElement(
            'div',
            { className: 'dsb-tabs' },
            TABS.map((item) => React.createElement(Button, {
              key: item.id,
              label: item.label,
              active: tab === item.id,
              onClick: () => setTab(item.id),
            })),
          ),
          props.close !== undefined
            ? React.createElement(Button, { label: '关闭', variant: 'ghost', onClick: props.close })
            : null,
        ),
        React.createElement(
          'div',
          { className: 'dsb-content' },
          tab === 'library'
            ? React.createElement(LibraryTab, { notify, onChanged: reload, tagIndex: tags })
            : tab === 'graph'
              ? React.createElement(GraphTab, { notify, onChanged: reload })
              : React.createElement(SettingsTab, { notify, onChanged: reload, config, stats }),
        ),
        React.createElement(Toast, { toast }),
      );
    }

    /* ---------------------------------------------------------------- *
     * Styles
     * ---------------------------------------------------------------- */

    const CSS = [
      // DSH declares its --dsw-* tokens on <body> only; a var() reference
      // resolves against the element that declares it, so derived aliases must
      // also live on body rather than :root.
      'body {',
      '  --dsb-accent: var(--dsw-alias-brand-primary, #4c8dff);',
      '  --dsb-fg: var(--dsw-alias-label-primary, #1f2430);',
      '  --dsb-fg-dim: var(--dsw-alias-label-secondary, #5b6273);',
      '  --dsb-fg-faint: var(--dsw-alias-label-tertiary, #8b93a7);',
      '  --dsb-bg: var(--dsw-alias-bg-base, #ffffff);',
      '  --dsb-bg-1: var(--dsw-alias-bg-layer-1, #f7f8fa);',
      '  --dsb-bg-2: var(--dsw-alias-bg-layer-2, #eef0f4);',
      '  --dsb-border: var(--dsw-alias-border-l1, rgba(0,0,0,0.10));',
      '  --dsb-border-2: var(--dsw-alias-border-l2, rgba(0,0,0,0.18));',
      '  --dsb-danger: var(--dsw-alias-state-error-primary, #d9564f);',
      '  --dsb-radius: var(--dsw-radius-md, 8px);',
      '}',
      '.dsb-page { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsb-fg); background:var(--dsb-bg); }',
      '.dsb-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:14px 18px 10px; border-bottom:1px solid var(--dsb-border); }',
      '.dsb-head-title { font-size:16px; font-weight:600; }',
      '.dsb-head-sub { font-size:12px; color:var(--dsb-fg-faint); flex:1 1 240px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.dsb-tabs { display:flex; gap:6px; }',
      '.dsb-content { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; padding:12px 18px 18px; overflow:auto; }',
      '.dsb-btn { font:inherit; font-size:13px; padding:5px 12px; border-radius:var(--dsb-radius); border:1px solid var(--dsb-border); background:var(--dsb-bg-1); color:var(--dsb-fg); cursor:pointer; white-space:nowrap; }',
      '.dsb-btn:hover:not(:disabled) { background:var(--dsb-bg-2); }',
      '.dsb-btn:disabled { opacity:.45; cursor:not-allowed; }',
      '.dsb-btn.active { background:var(--dsb-accent); border-color:var(--dsb-accent); color:#fff; }',
      '.dsb-btn-primary { background:var(--dsb-accent); border-color:var(--dsb-accent); color:#fff; }',
      '.dsb-btn-danger { color:var(--dsb-danger); border-color:var(--dsb-danger); background:transparent; }',
      '.dsb-input { font:inherit; font-size:13px; padding:5px 9px; border-radius:var(--dsb-radius); border:1px solid var(--dsb-border); background:var(--dsb-bg-1); color:var(--dsb-fg); min-width:0; }',
      '.dsb-input:focus { outline:2px solid var(--dsb-accent); outline-offset:-1px; }',
      '.dsb-search { flex:1 1 220px; }',
      '.dsb-select { flex:0 0 auto; }',
      '.dsb-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:10px; }',
      '.dsb-toolbar-info { font-size:12px; color:var(--dsb-fg-faint); margin-right:auto; }',
      '.dsb-row { display:flex; gap:8px; align-items:center; }',
      '.dsb-row-end { justify-content:flex-end; }',
      '.dsb-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }',
      '.dsb-chip { display:inline-flex; align-items:center; gap:5px; font:inherit; font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--dsb-border); background:var(--dsb-bg-1); color:var(--dsb-fg-dim); cursor:pointer; }',
      '.dsb-chip.active { border-color:var(--dsb-accent); color:var(--dsb-accent); }',
      '.dsb-chip.static { cursor:default; }',
      '.dsb-chip-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }',
      '.dsb-lib { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }',
      '.dsb-lib-body { display:flex; gap:14px; min-height:0; flex:1 1 auto; align-items:stretch; }',
      '.dsb-lib-list { flex:0 0 300px; max-width:36%; display:flex; flex-direction:column; min-height:0; border:1px solid var(--dsb-border); border-radius:var(--dsb-radius); overflow:hidden; background:var(--dsb-bg-1); }',
      '.dsb-lib-list-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; font-size:12px; color:var(--dsb-fg-faint); border-bottom:1px solid var(--dsb-border); }',
      '.dsb-lib-item { display:flex; gap:8px; align-items:flex-start; text-align:left; font:inherit; padding:9px 10px; border:0; border-bottom:1px solid var(--dsb-border); background:transparent; color:inherit; cursor:pointer; }',
      '.dsb-lib-item:hover { background:var(--dsb-bg-2); }',
      '.dsb-lib-item.active { background:var(--dsb-bg-2); box-shadow:inset 3px 0 0 var(--dsb-accent); }',
      '.dsb-lib-item-dot { width:8px; height:8px; border-radius:50%; margin-top:5px; flex:0 0 auto; }',
      '.dsb-lib-item-main { display:flex; flex-direction:column; gap:3px; min-width:0; }',
      '.dsb-lib-item-title { font-size:13px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }',
      '.dsb-lib-item-meta { font-size:11px; color:var(--dsb-fg-faint); }',
      '.dsb-lib-list .dsb-lib-item:last-child { border-bottom:0; }',
      '.dsb-lib-detail { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:8px; border:1px solid var(--dsb-border); border-radius:var(--dsb-radius); padding:12px; background:var(--dsb-bg-1); overflow:auto; }',
      '.dsb-lib-detail.dsb-empty { align-items:center; justify-content:center; text-align:center; }',
      '.dsb-input-title { font-size:15px; font-weight:600; }',
      '.dsb-textarea { flex:1 1 auto; min-height:260px; resize:vertical; font-family:var(--dsw-font-family, ui-monospace, monospace); line-height:1.55; }',
      '.dsb-empty { color:var(--dsb-fg-faint); font-size:13px; padding:16px; text-align:center; }',
      '.dsb-graph { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }',
      '.dsb-graph-body { display:flex; gap:14px; min-height:0; flex:1 1 auto; }',
      '.dsb-canvas-wrap { position:relative; flex:1 1 auto; min-width:0; border:1px solid var(--dsb-border); border-radius:var(--dsb-radius); background:var(--dsb-bg-1); overflow:hidden; }',
      '.dsb-canvas { width:100%; height:100%; display:block; touch-action:none; cursor:crosshair; }',
      '.dsb-canvas-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--dsb-fg-faint); font-size:13px; padding:24px; text-align:center; pointer-events:none; }',
      '.dsb-node { cursor:grab; }',
      '.dsb-node-label { font-size:10px; fill:var(--dsb-fg-dim); pointer-events:none; user-select:none; }',
      '.dsb-side { flex:0 0 268px; max-width:40%; display:flex; flex-direction:column; gap:10px; overflow:auto; }',
      '.dsb-legend, .dsb-time, .dsb-selection, .dsb-details { border:1px solid var(--dsb-border); border-radius:var(--dsb-radius); background:var(--dsb-bg-1); padding:10px; }',
      '.dsb-legend-title { font-size:12px; font-weight:600; color:var(--dsb-fg-dim); margin:6px 0 6px; }',
      '.dsb-legend-title:first-child { margin-top:0; }',
      '.dsb-legend-actions { display:flex; gap:6px; margin-bottom:8px; }',
      '.dsb-legend-empty { padding:8px; }',
      '.dsb-legend-row { display:flex; align-items:center; gap:7px; width:100%; font:inherit; font-size:12px; padding:3px 4px; border:0; border-radius:6px; background:transparent; color:var(--dsb-fg); cursor:pointer; text-align:left; }',
      '.dsb-legend-row:hover { background:var(--dsb-bg-2); }',
      '.dsb-legend-row.off { opacity:.38; }',
      '.dsb-legend-name { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.dsb-legend-count { color:var(--dsb-fg-faint); font-size:11px; }',
      '.dsb-legend-dot { width:9px; height:9px; border-radius:3px; flex:0 0 auto; }',
      '.dsb-time-head { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; color:var(--dsb-fg-dim); margin-bottom:8px; }',
      '.dsb-time-range { flex:1 1 auto; font-weight:400; color:var(--dsb-fg-faint); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.dsb-histogram { display:flex; align-items:flex-end; gap:3px; height:64px; margin-bottom:8px; }',
      '.dsb-histogram-empty { height:auto; }',
      '.dsb-bar { flex:1 1 0; min-width:4px; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:2px; padding:0; border:0; background:transparent; cursor:pointer; }',
      '.dsb-bar-fill { width:100%; border-radius:3px 3px 0 0; background:var(--dsb-accent); opacity:.45; min-height:4px; }',
      '.dsb-bar.active .dsb-bar-fill { opacity:1; }',
      '.dsb-bar-label { font-size:9px; color:var(--dsb-fg-faint); writing-mode:horizontal-tb; overflow:hidden; }',
      '.dsb-time-inputs { display:flex; align-items:center; gap:6px; }',
      '.dsb-date { flex:1 1 auto; font-size:12px; }',
      '.dsb-time-sep { font-size:12px; color:var(--dsb-fg-faint); }',
      '.dsb-selection-head { font-size:12px; font-weight:600; color:var(--dsb-fg-dim); margin-bottom:8px; }',
      '.dsb-selection-actions { display:flex; flex-wrap:wrap; gap:6px; }',
      '.dsb-selection-list { margin-top:8px; display:flex; flex-direction:column; gap:3px; max-height:150px; overflow:auto; }',
      '.dsb-selection-row { font-size:11px; color:var(--dsb-fg-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
      '.dsb-selection-row.muted { color:var(--dsb-fg-faint); }',
      '.dsb-details-title { font-size:13px; font-weight:600; margin-bottom:4px; }',
      '.dsb-details-meta { font-size:11px; color:var(--dsb-fg-faint); margin-bottom:6px; }',
      '.dsb-details-summary { font-size:12px; color:var(--dsb-fg-dim); line-height:1.5; }',
      '.dsb-settings { display:flex; flex-direction:column; gap:16px; max-width:760px; }',
      '.dsb-settings-group { display:flex; flex-direction:column; gap:9px; padding:12px; border:1px solid var(--dsb-border); border-radius:var(--dsb-radius); background:var(--dsb-bg-1); }',
      '.dsb-settings-title { font-size:13px; font-weight:600; }',
      '.dsb-settings-stats { font-size:12px; color:var(--dsb-fg-faint); }',
      '.dsb-field { display:flex; flex-direction:column; gap:4px; font-size:12px; }',
      '.dsb-field-inline { flex-direction:row; align-items:center; gap:8px; }',
      '.dsb-field-label { font-weight:500; color:var(--dsb-fg-dim); }',
      '.dsb-field-hint { font-size:11px; color:var(--dsb-fg-faint); line-height:1.5; }',
      '.dsb-git-output { margin:0; font-size:11px; line-height:1.5; background:var(--dsb-bg-2); border-radius:6px; padding:8px; max-height:180px; overflow:auto; white-space:pre-wrap; }',
      '.dsb-modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.38); display:flex; align-items:center; justify-content:center; z-index:60; }',
      '.dsb-modal { width:min(520px, 92vw); border-radius:12px; background:var(--dsb-bg); border:1px solid var(--dsb-border-2); box-shadow:0 18px 48px rgba(0,0,0,.25); padding:16px; display:flex; flex-direction:column; gap:10px; }',
      '.dsb-modal-title { font-size:14px; font-weight:600; }',
      '.dsb-modal-body { display:flex; flex-direction:column; gap:8px; font-size:12px; color:var(--dsb-fg-dim); line-height:1.55; }',
      '.dsb-modal-footer { display:flex; justify-content:flex-end; gap:8px; }',
      '.dsb-modal-hint { font-size:12px; color:var(--dsb-fg-faint); line-height:1.55; }',
      '.dsb-toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); background:var(--dsb-fg); color:var(--dsb-bg); font-size:13px; padding:8px 16px; border-radius:999px; z-index:80; box-shadow:0 8px 24px rgba(0,0,0,.22); max-width:76vw; text-align:center; }',
      '.dsb-toast.error { background:var(--dsb-danger); color:#fff; }',
    ].join('\n');

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    const inject = ['slots'];

    /**
     * @param {object} ctx
     */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-second-brain');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      }, 'second-brain: styles');

      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        {
          name: 'settings.section',
          // `id` is mandatory for a list slot: it is the nav cell key.
          id: 'second-brain',
          order: 26,
          label: '第二大脑',
        },
        (owner) => React.createElement(BrainPage, owner || {}),
      )), 'second-brain: settings page');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-second-brain';
    exports.__test = {
      // Components are exported so the test suite can smoke-render them: a crash
      // in the settings page would otherwise only show up in the browser.
      BrainPage,
      LibraryTab,
      GraphTab,
      SettingsTab,
      layoutGraph,
      screenToSvgUnits,
      screenToWorld,
      zoomAround,
      exceedsDragThreshold,
      filterGraph,
      monthHistogram,
      nodesInRect,
      colorForTag,
      colorForNode,
      nodeRadius,
      hashString,
      kindLabel,
      formatDay,
      parseDay,
      formatStamp,
      clamp,
      KINDS,
      TAG_PALETTE,
    };
    return module.exports;
  },
});
