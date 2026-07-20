<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/devtools

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fdevtools?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/devtools)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

In-page devtools for AzerothJS apps - a tabbed panel that shows your live
reactive graph the way the React, Vue, and Angular devtools show theirs, but
built for fine-grained reactivity: every signal, effect, and memo, who owns
it, what it depends on, why it re-ran, and whether anything is leaking.

It is dev-only. Install it behind an `import.meta.env.DEV` guard and it
tree-shakes out of production builds. The reactivity core carries no devtools
cost unless a hook is installed.

## Install

```sh
npm i -D @azerothjs/devtools
```

## Quick start

Install the panel **before you mount your app**, so nodes created during the
first render are captured:

```ts
// src/dev.ts - imported first, only in dev
if (import.meta.env.DEV)
{
    const { installDevtools } = await import('@azerothjs/devtools');
    installDevtools();
}
```

```ts
// src/main.ts
import './dev';   // must be the first import
// ... mount your app
```

A small `AZ` launcher appears in the corner with a live effect count. Click
it to open the panel; drag the launcher to move it. Add
`?no-devtools` to the URL to skip installing it.

## The panel

The panel never covers your app: it starts as a launcher icon and remembers
its size, dock side, position, and active tab in `localStorage`.

- **Float or dock.** Drag the title bar to move a floating panel; resize it
  from the bottom-right corner. Or dock it to the left, right, or bottom edge
  (Settings tab) and drag the inner edge to resize.
- **Pop out.** Settings -> "pop out to window" opens the inspector in its own
  window so it never overlaps the app.

### Tabs

- **Tree** - every signal, effect, and memo grouped by the source file that
  created it, busiest file first. Signals and memos show their current value
  inline. This answers "what does this component own?".
- **Graph** - the dependency graph: each effect/memo and the producers it
  reads. Edges that went stale since the last run are highlighted, so you can
  see what is about to recompute. Select a node and the tab draws a focused
  **dependency diagram** - what it reads on the left, the node in the center,
  what re-runs when it changes on the right - all boxes clickable to walk the
  graph.
- **Timeline** - the recent stream of created / run / write / disposed events.
  Each `run` shows **why it ran** - the signal whose write triggered it (or
  `(initial)` for a first run). A **record toggle** freezes capture while you
  reproduce a bug (the live model keeps updating), and **Clear** resets the
  stream.
- **Perf** - liveness per kind (live vs. created vs. disposed) plus a
  trend-based leak detector that samples the live effect/memo count over wall-
  clock time and warns only on *sustained growth* - so a freshly loaded app
  with many live nodes and zero disposals is never falsely flagged. Below that,
  the activity hotspots, ranked by re-runs and writes.
- **Settings** - dock controls, pop-out, naming hints, and **session
  export/import**: dump the whole state (graph, timeline, values, history) to a
  JSON file (also copied to the clipboard) to attach to a bug report, and load
  one back to inspect it read-only - even on a different machine.

Click any row to open the **inspector drawer**: kind, name, source, current
value (editable for signals - type a value and Set writes it into your running
app), a **value-history sparkline** for numeric signals/memos, run/write
counts, what it **reads**, and what it is **used by** (both clickable to
navigate). Under Vite, the **source** line is a link that opens the exact
`file:line` in your editor via `/__open-in-editor`.

Filter any list with the search box (matches name, file, or kind); press
**Enter** to jump straight to the first match's inspector.

**Keyboard:** with the pointer over the panel, **Arrow Up/Down** move the
selection between rows and **Escape** closes the inspector.

### Name your nodes

Rows are far more readable when signals and effects are named:

```ts
const [count, setCount] = createSignal(0, { name: 'count' });
createEffect(() => render(count()), { name: 'count-binding' });
```

Unnamed nodes show as `#<id>`.

## The agent (build your own frontend)

`installDevtools()` is a frontend over an **agent** - the only code that
touches the framework. The agent installs the reactivity hook, keeps a live
model (pruned on dispose), buffers a bounded timeline, and answers
graph/value/health queries. Everything it returns is JSON-serializable, so the
same agent can drive an in-page panel, a pop-out window, or a browser
extension over `postMessage`.

```ts
import { createAgent } from '@azerothjs/devtools';

const agent = createAgent();              // installs the hook
agent.subscribe(() =>                      // coalesced change notifications
{
    const model = agent.getModel();        // live nodes + counts + last write
    const graph = agent.getGraph();         // nodes + dependency edges
    const events = agent.getTimeline();     // recent reactive events (with cause)
    const health = agent.getHealth();       // liveness per kind + leak flags
    render(model);
});

agent.peek(id);            // read a signal/memo value (preview string)
agent.poke(id, 42);        // write a new value into a signal
agent.getHistory(id);      // recent numeric values (for a sparkline)
agent.exportSession();     // a full JSON-serializable dump, for bug reports
agent.uninstall();         // detach the hook
```

For a transport boundary (pop-out / extension), use `handle()`, which takes a
plain serializable request and returns a serializable response:

```ts
const model = agent.handle({ kind: 'model' });
const value = agent.handle({ kind: 'peek', id });
agent.handle({ kind: 'poke', id, value: 42 });
// other kinds: 'graph', 'timeline', 'health', 'history', 'export',
//              'setRecording', 'clearTimeline'
```

## How it stays leak-safe

The reactivity core attaches a small `dv` record to each producer/subscriber
and registers it in a `WeakRef` map, so the devtools never keep a
GC-managed signal alive. Disposed effects, memos, and roots emit a `disposed`
event and are pruned immediately - which is why switching pages updates the
panel without a reload.

The panel is plain DOM on purpose: it must not be built with the framework it
inspects, or observing it would feed back into the graph it is showing.

## License

MIT
