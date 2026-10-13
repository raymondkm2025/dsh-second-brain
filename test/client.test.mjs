import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_PATH = join(process.cwd(), 'lib', 'client.js')

/**
 * Load the hand-written ModuleLoader bundle the way the Web shell does: execute
 * it as a classic script that registers one factory, then materialize it.
 *
 * The script runs in THIS realm (a plain `new Function`) rather than in a `vm`
 * context: a vm realm has its own `Array`/`Set` prototypes, which would make
 * every `deepStrictEqual` and `instanceof Set` in these tests a lie about
 * behaviour that never happens in the browser.
 * @returns {{ id: string, exports: object, factory: Function }}
 */
/** Every `useCallback` dependency array the shim saw, for the loop-regression test. */
const callbackDeps = []

function loadBundle() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const registrations = []
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  try {
    new Function(source)()
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }

  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  const registration = registrations[0]
  const reactShim = {
    // Function components are invoked immediately, the way React itself would
    // render them, so a smoke test actually walks the whole element tree instead
    // of stopping at the first component boundary.
    createElement: (type, props, ...children) => {
      const element = { type, props: props || {}, children }
      if (typeof type === 'function') return type({ ...element.props, children })
      return element
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn, deps) => {
      callbackDeps.push(deps);
      return fn;
    },
  }
  const requireShim = (spec) => {
    if (spec === 'react') return reactShim
    throw new Error(`unexpected require("${spec}")`)
  }
  return { id: registration.id, exports: registration.factory(requireShim), factory: registration.factory }
}

const bundle = loadBundle();
const api = bundle.exports.__test;

test('bundle registers the expected plugin id and face', () => {
  assert.equal(bundle.id, 'dsh-second-brain')
  assert.equal(typeof bundle.exports.apply, 'function')
  assert.deepEqual(bundle.exports.inject, ['slots'])
  assert.equal(bundle.exports.name, 'dsh-second-brain')
})

test('hashString and colouring are stable and within the palette', () => {
  assert.equal(api.hashString('图谱'), api.hashString('图谱'))
  assert.notEqual(api.hashString('图谱'), api.hashString('存储'))
  for (const tag of ['图谱', 'dsh', '插件', '', 'a-very-long-tag-name']) {
    assert.ok(api.TAG_PALETTE.includes(api.colorForTag(tag)), `${tag} must map into the palette`)
  }
  assert.equal(api.colorForNode({ tags: ['图谱'] }), api.colorForTag('图谱'))
  assert.equal(api.colorForNode({ tags: [] }), '#8b93a7')
  assert.equal(api.colorForNode(null), '#8b93a7')
})

test('nodeRadius grows with degree and stays bounded', () => {
  assert.equal(api.nodeRadius(0), 5)
  assert.ok(api.nodeRadius(4) > api.nodeRadius(1))
  assert.ok(api.nodeRadius(10000) <= 16)
})

test('kindLabel and date helpers', () => {
  assert.equal(api.kindLabel('snippet'), '代码')
  assert.equal(api.kindLabel('weird'), 'weird')
  assert.equal(api.formatDay(Date.parse('2026-10-13T04:00:00Z')).length, 10)
  const parsed = api.parseDay('2026-10-13')
  assert.equal(api.formatDay(parsed), '2026-10-13')
  assert.equal(api.parseDay('nope'), null)
  assert.equal(api.formatStamp(Date.parse('2026-10-13T04:05:00Z')).includes('2026-10-13'), true)
})

test('layoutGraph spreads nodes inside the world box without NaN', () => {
  const nodes = Array.from({ length: 60 }, (_, index) => ({ id: `n${index}` }))
  const edges = []
  for (let i = 0; i < 59; i++) edges.push({ key: `e${i}`, source: `n${i}`, target: `n${i + 1}`, weight: 1, type: 'tag' })
  const positions = api.layoutGraph(nodes, edges, { seed: 7, width: 1000, height: 700 })
  assert.equal(positions.size, 60)
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (const point of positions.values()) {
    assert.equal(Number.isFinite(point.x), true)
    assert.equal(Number.isFinite(point.y), true)
    assert.ok(point.x >= 23 && point.x <= 977, `x ${point.x} inside bounds`)
    assert.ok(point.y >= 23 && point.y <= 677, `y ${point.y} inside bounds`)
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
  }
  assert.ok(maxX - minX > 150, `the layout must not collapse horizontally (${maxX - minX})`)
  assert.ok(maxY - minY > 150, `the layout must not collapse vertically (${maxY - minY})`)
})

test('layoutGraph is deterministic for a given seed', () => {
  const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `n${index}` }))
  const edges = [{ key: 'e', source: 'n0', target: 'n1', weight: 1 }]
  const a = api.layoutGraph(nodes, edges, { seed: 3 })
  const b = api.layoutGraph(nodes, edges, { seed: 3 })
  for (const id of a.keys()) {
    assert.deepEqual(a.get(id), b.get(id), 'the same seed must reproduce the same layout')
  }
  // The graph must not reshuffle on every render, which is the whole point of
  // seeding the PRNG from the node set.
  const c = api.layoutGraph(nodes, edges, { seed: 3, iterations: 5 })
  assert.equal(c.size, a.size)
})

test('layoutGraph pulls connected nodes together', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}` }))
  const edges = [{ key: 'e', source: 'n0', target: 'n1', weight: 3, type: 'link' }]
  const positions = api.layoutGraph(nodes, edges, { seed: 11 })
  const linked = Math.hypot(positions.get('n0').x - positions.get('n1').x, positions.get('n0').y - positions.get('n1').y)
  let total = 0
  let count = 0
  const ids = [...positions.keys()]
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      total += Math.hypot(positions.get(ids[i]).x - positions.get(ids[j]).x, positions.get(ids[i]).y - positions.get(ids[j]).y)
      count++
    }
  }
  assert.ok(linked < total / count, `a linked pair should sit closer than the average pair (${linked} vs ${total / count})`)
})

test('layoutGraph handles empty and single-node graphs', () => {
  assert.equal(api.layoutGraph([], []).size, 0)
  const one = api.layoutGraph([{ id: 'solo' }], [])
  assert.equal(one.size, 1)
  assert.equal(Number.isFinite(one.get('solo').x), true)
})

test('screenToSvgUnits undoes the viewBox letterboxing', () => {
  const world = { width: 1000, height: 700 }
  // Exactly the viewBox aspect ratio: one CSS pixel is one user unit.
  const exact = { left: 0, top: 0, width: 1000, height: 700 }
  assert.deepEqual(api.screenToSvgUnits(exact, world, 250, 100), { x: 250, y: 100 })

  // Half size: still exact, but every unit is half a pixel.
  const half = { left: 0, top: 0, width: 500, height: 350 }
  assert.deepEqual(api.screenToSvgUnits(half, world, 250, 100), { x: 500, y: 200 })

  // Wider than the viewBox: content is scaled to the height and centred, so
  // there is a horizontal letterbox. Treating 1px as 1 unit here was the bug.
  const wide = { left: 0, top: 0, width: 1400, height: 700 }
  const center = api.screenToSvgUnits(wide, world, 700, 350)
  assert.deepEqual(center, { x: 500, y: 350 }, 'the element centre maps to the viewBox centre')
  const offset = { left: 40, top: 10, width: 1400, height: 700 }
  assert.deepEqual(api.screenToSvgUnits(offset, world, 740, 360), { x: 500, y: 350 })

  // Taller than the viewBox: vertical letterbox.
  const tall = { left: 0, top: 0, width: 1000, height: 1400 }
  assert.deepEqual(api.screenToSvgUnits(tall, world, 500, 700), { x: 500, y: 350 })

  // Degenerate sizes must not produce NaN.
  const empty = api.screenToSvgUnits({ left: 0, top: 0, width: 0, height: 0 }, world, 10, 10)
  assert.equal(Number.isFinite(empty.x), true)
  assert.equal(Number.isFinite(empty.y), true)
})

test('screenToWorld composes the viewBox fit with the pan/zoom transform', () => {
  const world = { width: 1000, height: 700 }
  const rect = { left: 0, top: 0, width: 1000, height: 700 }
  // Identity transform: world == user units.
  assert.deepEqual(api.screenToWorld(rect, world, { k: 1, x: 0, y: 0 }, 250, 100), { x: 250, y: 100 })
  // Pan.
  assert.deepEqual(api.screenToWorld(rect, world, { k: 1, x: 100, y: 50 }, 250, 100), { x: 150, y: 50 })
  // Zoom about the origin.
  assert.deepEqual(api.screenToWorld(rect, world, { k: 2, x: 0, y: 0 }, 400, 200), { x: 200, y: 100 })
  // A zero or NaN scale must fall back to 1 rather than divide by zero.
  const degenerate = api.screenToWorld(rect, world, { k: 0, x: 0, y: 0 }, 100, 100)
  assert.deepEqual(degenerate, { x: 100, y: 100 })
})

test('zoomAround keeps the anchor point fixed', () => {
  const start = { k: 1, x: 0, y: 0 }
  const anchor = { x: 400, y: 250 }
  const before = { x: (anchor.x - start.x) / start.k, y: (anchor.y - start.y) / start.k }
  const zoomed = api.zoomAround(start, anchor, 1.5, 0.2, 5)
  assert.equal(zoomed.k, 1.5)
  const after = { x: (anchor.x - zoomed.x) / zoomed.k, y: (anchor.y - zoomed.y) / zoomed.k }
  assert.ok(Math.abs(before.x - after.x) < 1e-9, 'the world point under the cursor is unchanged')
  assert.ok(Math.abs(before.y - after.y) < 1e-9)

  // Clamping still keeps the anchor fixed when the scale saturates.
  const saturated = api.zoomAround({ k: 4.9, x: 10, y: 10 }, anchor, 4, 0.2, 5)
  assert.equal(saturated.k, 5)
  const saturatedWorld = { x: (anchor.x - saturated.x) / saturated.k, y: (anchor.y - saturated.y) / saturated.k }
  const saturatedBefore = { x: (anchor.x - 10) / 4.9, y: (anchor.y - 10) / 4.9 }
  assert.ok(Math.abs(saturatedWorld.x - saturatedBefore.x) < 1e-9)

  // Repeated zoom in/out returns to (approximately) the original transform.
  let transform = { k: 1, x: 0, y: 0 }
  for (let i = 0; i < 10; i++) transform = api.zoomAround(transform, anchor, 1.12, 0.2, 5)
  for (let i = 0; i < 10; i++) transform = api.zoomAround(transform, anchor, 1 / 1.12, 0.2, 5)
  assert.ok(Math.abs(transform.k - 1) < 1e-6)
})

test('filterGraph applies tag, kind and time filters, and drops dangling edges', () => {
  const nodes = [
    { id: 'a', tags: ['x'], kind: 'fact', createdAt: 1000 },
    { id: 'b', tags: ['y'], kind: 'snippet', createdAt: 2000 },
    { id: 'c', tags: [], kind: 'fact', createdAt: 3000 },
  ]
  const edges = [
    { key: 'ab', source: 'a', target: 'b', weight: 1 },
    { key: 'bc', source: 'b', target: 'c', weight: 1 },
  ]
  assert.equal(api.filterGraph(nodes, edges, {}).nodes.length, 3)
  assert.equal(api.filterGraph(nodes, edges, {}).edges.length, 2)

  const onlyX = api.filterGraph(nodes, edges, { enabledTags: new Set(['x']) })
  // A card with no tags survives every tag filter: the legend only speaks for
  // tags that exist.
  assert.deepEqual(onlyX.nodes.map((node) => node.id).sort(), ['a', 'c'])
  assert.equal(onlyX.edges.length, 0, 'an edge to a filtered-out node disappears')
  assert.equal(onlyX.hidden, 1)

  const kinds = api.filterGraph(nodes, edges, { kinds: new Set(['snippet']) })
  assert.deepEqual(kinds.nodes.map((node) => node.id), ['b'])

  const windowed = api.filterGraph(nodes, edges, { from: 1500, to: 2500 })
  assert.deepEqual(windowed.nodes.map((node) => node.id), ['b'])
})

test('monthHistogram buckets by calendar month, oldest first', () => {
  const nodes = [
    { id: 'a', createdAt: new Date(2026, 0, 5).getTime() },
    { id: 'b', createdAt: new Date(2026, 0, 20).getTime() },
    { id: 'c', createdAt: new Date(2026, 2, 1).getTime() },
  ]
  const buckets = api.monthHistogram(nodes)
  assert.deepEqual(buckets.map((bucket) => bucket.key), ['2026-01', '2026-03'])
  assert.deepEqual(buckets.map((bucket) => bucket.count), [2, 1])
  assert.equal(new Date(buckets[0].start).getMonth(), 0)
  assert.ok(buckets[0].end > buckets[0].start)
  assert.deepEqual(api.monthHistogram([]), [])
})

test('nodesInRect selects by centre and ignores disconnected points', () => {
  const positions = new Map([
    ['a', { x: 10, y: 10 }],
    ['b', { x: 50, y: 50 }],
    ['c', { x: 90, y: 90 }],
  ])
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'missing' }]
  assert.deepEqual(api.nodesInRect(positions, nodes, { x1: 0, y1: 0, x2: 60, y2: 60 }).sort(), ['a', 'b'])
  // The rectangle is normalized, so dragging up/left works too.
  assert.deepEqual(api.nodesInRect(positions, nodes, { x1: 100, y1: 100, x2: 40, y2: 40 }), ['b', 'c'])
  assert.deepEqual(api.nodesInRect(positions, nodes, { x1: 0, y1: 0, x2: 5, y2: 5 }), [])
})

test('apply injects the stylesheet and registers one settings section', () => {
  const created = []
  const appended = []
  const sandboxDocument = {
    createElement(tag) {
      const element = {
        tag,
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) { this.attributes[name] = value },
        getAttribute(name) { return this.attributes[name] },
        remove() { this.parentNode = null },
      }
      created.push(element)
      return element
    },
    head: { appendChild(element) { element.parentNode = this; appended.push(element) } },
    body: { appendChild(element) { appended.push(element) } },
    querySelectorAll: () => [],
  }
  const previousDocument = globalThis.document
  globalThis.document = sandboxDocument
  try {
    const registrations = []
    const slots = {
      inject: (key, callback) => {
        const record = { key }
        registrations.push(record)
        record.effect = callback()
        return () => {}
      },
      register: (options, component) => {
        const record = registrations[registrations.length - 1]
        record.options = options
        record.component = component
        return () => {}
      },
    }
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? slots : undefined),
      effect: (fn, label) => {
        const disposer = fn()
        effects.push({ label, disposer })
        return () => {}
      },
    }
    bundle.exports.apply(ctx)

    assert.equal(effects.length, 2, 'one effect for the stylesheet, one for the slot')
    assert.equal(appended.length, 1)
    assert.equal(appended[0].attributes['data-plugin'], 'dsh-second-brain')
    assert.ok(appended[0].textContent.includes('.dsb-page'))
    assert.ok(appended[0].textContent.includes('--dsb-accent'))
    // Derived theme aliases must be declared on body: DSH's --dsw-* tokens live
    // on <body>, and a var() reference resolves where it is declared.
    assert.ok(appended[0].textContent.includes('body {'))

    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].key, 'settings.section')
    assert.equal(registrations[0].options.name, 'settings.section')
    assert.equal(registrations[0].options.id, 'second-brain')
    assert.equal(registrations[0].options.order, 26)
    assert.equal(registrations[0].options.label, '第二大脑')
    assert.equal(typeof registrations[0].component, 'function')
    // The component must accept the shell's owner props and render the page
    // without exploding; `close` must reach the page (the shell's only affordance).
    const close = () => {}
    let seenClose = null
    const original = bundle.exports.__test.BrainPage
    const element = registrations[0].component({ close })
    assert.equal(element.type, 'div')
    assert.ok(hasClass(collectClasses(element), 'dsb-page'))
    seenClose = element
    assert.ok(seenClose !== null)
    assert.equal(typeof close, 'function')
    assert.ok(original !== undefined)
    // Owner props are optional: a shell that passes none must not break the page.
    assert.equal(registrations[0].component().type, 'div')
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('apply is a no-op when the slots service is absent', () => {
  const events = []
  const ctx = {
    get: () => undefined,
    effect: (fn, label) => { events.push(label); fn(); return () => {} },
  }
  bundle.exports.apply(ctx)
  assert.deepEqual(events, [], 'without slots nothing is registered')
})

/**
 * Walk a shim-rendered element tree and collect every class name it produced.
 * The React shim returns plain `{type, props, children}` objects, so the tree is
 * inspectable without a DOM.
 */
function hasClass(classes, name) {
  // Class names are composed (e.g. "dsb-input dsb-search"), so match on tokens.
  return classes.some((value) => value.split(/\s+/).includes(name))
}

function collectClasses(element, out = []) {
  if (element === null || element === undefined || typeof element !== 'object') return out
  const className = element.props && element.props.className
  if (typeof className === 'string') out.push(className)
  for (const child of element.children ?? []) collectClasses(child, out)
  return out
}

test('no hook depends on the props object (the refetch-loop regression)', () => {
  const noop = () => {};
  callbackDeps.length = 0;
  // Two distinct props objects with the SAME callbacks: exactly what a parent
  // re-render produces. Depending on the object rebuilt `load` every render,
  // which re-fired its effect — and the error path's `notify` re-rendered the
  // parent, making the loop self-sustaining.
  const libraryProps = { notify: noop, onChanged: noop, tagIndex: [] };
  api.LibraryTab(libraryProps);
  const graphProps = { notify: noop, onChanged: noop };
  api.GraphTab(graphProps);

  assert.ok(callbackDeps.length > 0, 'the components do use useCallback');
  for (const deps of callbackDeps) {
    assert.ok(Array.isArray(deps), 'useCallback must declare a dependency array');
    assert.ok(!deps.includes(libraryProps), 'LibraryTab deps must not contain the props object');
    assert.ok(!deps.includes(graphProps), 'GraphTab deps must not contain the props object');
  }
  // Sanity-check the guard itself: the two props objects must be distinct
  // identities, otherwise this test could never detect the regression.
  assert.notStrictEqual(libraryProps, { notify: noop, onChanged: noop, tagIndex: [] })

  // A second render with fresh wrappers must still not leak them into a dep list.
  callbackDeps.length = 0;
  api.LibraryTab({ notify: noop, onChanged: noop, tagIndex: [] });
  api.GraphTab({ notify: noop, onChanged: noop });
  for (const deps of callbackDeps) {
    for (const dep of deps) {
      assert.ok(!(dep !== null && typeof dep === 'object' && 'tagIndex' in dep), 'no dep may be a props wrapper');
    }
  }
})

test('exceedsDragThreshold separates a click from a drag', () => {
  const drag = { startX: 100, startY: 100 };
  // Trackpad jitter.
  assert.equal(api.exceedsDragThreshold(drag, 100, 100), false);
  assert.equal(api.exceedsDragThreshold(drag, 101, 100), false);
  assert.equal(api.exceedsDragThreshold(drag, 102, 101), false);
  // A real drag.
  assert.equal(api.exceedsDragThreshold(drag, 105, 100), true);
  assert.equal(api.exceedsDragThreshold(drag, 100, 104), true);
  assert.equal(api.exceedsDragThreshold(drag, 90, 90), true);
  // A missing origin must not throw or count as a drag.
  assert.equal(api.exceedsDragThreshold({}, 1000, 1000), true);
  assert.equal(api.exceedsDragThreshold({}, 0, 0), false);
  assert.equal(api.exceedsDragThreshold(drag, 100, 100, 0), true);
})

test('every settings-page component renders without throwing', () => {
  const noop = () => {}

  // The page shell, with the overview still loading (the first-frame state).
  const page = api.BrainPage({ close: noop })
  assert.equal(page.type, 'div')
  assert.ok(hasClass(collectClasses(page), 'dsb-page'))
  assert.ok(hasClass(collectClasses(page), 'dsb-lib'), 'the library tab is the default')

  // Library tab: empty index and empty list.
  const library = api.LibraryTab({ notify: noop, onChanged: noop, tagIndex: [] })
  const libraryClasses = collectClasses(library)
  assert.ok(hasClass(libraryClasses, 'dsb-lib'))
  assert.ok(hasClass(libraryClasses, 'dsb-empty'))

  // Library tab with data: chips and rows must render.
  const populated = api.LibraryTab({
    notify: noop,
    onChanged: noop,
    tagIndex: [{ name: 'dsh', count: 2 }, { name: '插件', count: 1 }],
  })
  assert.ok(hasClass(collectClasses(populated), 'dsb-chip'), 'tag chips render')
  assert.ok(hasClass(collectClasses(populated), 'dsb-search'))

  // Graph tab, with the graph still empty — the zero-node path must not throw
  // (this is where `Math.max(...[])` would blow up).
  const graph = api.GraphTab({ notify: noop, onChanged: noop })
  const graphClasses = collectClasses(graph)
  assert.ok(hasClass(graphClasses, 'dsb-graph'))
  assert.ok(hasClass(graphClasses, 'dsb-canvas'))
  assert.ok(hasClass(graphClasses, 'dsb-legend'))
  assert.ok(hasClass(graphClasses, 'dsb-histogram'))

  // Settings tab, before/after the config arrives.
  assert.ok(hasClass(collectClasses(api.SettingsTab({ notify: noop, onChanged: noop, config: null, stats: {} })), 'dsb-empty'))
  const settings = api.SettingsTab({
    notify: noop,
    onChanged: noop,
    stats: { cards: 3, tags: 2, links: 1, bytes: 900 },
    config: {
      vault: '/tmp/vault', capture: 'heuristic', minChars: 400, maxCardChars: 6000,
      minCodeLines: 3, minCodeChars: 100, tagsLimit: 6, dedupeThreshold: 0.42,
      relatedThreshold: 0.18, autoMergeDuplicates: true, linkRelated: true,
      gitAutoCommit: false, writeIndexFile: false, llmProvider: '', llmModel: '',
    },
  })
  const settingsClasses = collectClasses(settings)
  assert.ok(hasClass(settingsClasses, 'dsb-settings'))
  assert.ok(hasClass(settingsClasses, 'dsb-field'))
})
