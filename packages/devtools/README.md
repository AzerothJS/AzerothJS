<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/devtools

**AzerothJS devtools - the in-page reactive inspector: components, timeline with causes, dependency graph, performance, and a live server bridge**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fdevtools?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/devtools)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. A development-time companion to [`azerothjs`](https://www.npmjs.com/package/azerothjs) - install it as a dev dependency alongside the framework.

An inspector that speaks the language you wrote, not the runtime's internals. A component that
declares `form login`, `resource user`, and `state count` shows up as exactly that - a `form`
group with its fields and validity, a `resource` with a live pending/ready/error badge, a named
`state` with its current value - instead of an anonymous pile of signals and effects. Every
re-run answers the question that matters: WHAT triggered it.

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/devtools-panel.png" alt="The devtools panel inspecting a form" width="720" />

> [!NOTE]
> Dev-only. Install it behind an `import.meta.env.DEV` guard and it tree-shakes out of
> production builds. The reactivity core carries zero devtools cost until a hook attaches.

---

## 📦 Install

> [!NOTE]
> ESM-only, Node >= 22; `azerothjs` is a peer dependency:

```sh
npm install --save-dev @azerothjs/devtools
```

---

## 📖 Overview

Install BEFORE mounting so every node created during the initial render is captured:

```ts
import { render } from 'azerothjs';
import App from './App.azeroth';

if (import.meta.env.DEV)
{
    const { installDevtools } = await import('@azerothjs/devtools');
    installDevtools({ server: import.meta.env.VITE_API_URL }); // server is optional
}

render(() => App(), document.getElementById('app')!);
```

A launcher pill with a live effect count appears bottom-right. Click it and the inspector
opens: an icon rail (Components, Timeline, Graph, Performance, Server, Settings), a
search-first toolbar (Ctrl+K from anywhere in the panel), and an inspector pane that sits to
the right on a wide panel and below on a narrow one. The panel floats (drag, corner-resize)
or docks to any edge; every geometry choice persists, and every restore is clamped so a
saved layout can never come back off-screen. The whole panel lives in a shadow root - your
app's CSS cannot touch it, and its CSS cannot touch your app.

---

## 🧭 What each view answers

- **Components** - "what does my app hold right now?" Files own their declarations; each
  declared primitive is ONE collapsible group with a live status badge (a `resource` shows
  pending/ready/error, a `stream` shows streaming/idle, a `form` shows valid/invalid/
  submitting), and bare `state`/`derived`/`effect` rows carry their names and current
  values. The list is windowed, so ten thousand nodes scroll as smoothly as fifty.
- **Timeline** - "what just happened?" Events arrive newest first, and one batch reads as
  one expandable row. Every run names the DIRECT producer that triggered it - `run values
  <- email` - reported by the runtime, not inferred. Click a cause to jump to it. Pause and
  clear without losing the live model.
- **Graph** - "who depends on whom?" Select any node for its dependency neighborhood (what
  it reads, what re-runs when it changes), plus the full consumer adjacency below. Amber
  marks a producer that changed since the consumer last ran.
- **Performance** - "is anything wrong?" Liveness per kind, a sustained-growth leak
  detector (a startup ramp never false-positives), and the busiest nodes ranked with
  relative activity bars.
- **Server** - the same inspector pointed at your backend. See below.
- **Settings** - dock, pop-out, session export/import (attach the JSON to a bug report and
  anyone can load it read-only), and the shortcut list.

Click any node anywhere and the inspector shows its value (signals are editable live -
Enter applies), a numeric history sparkline, the source location (click to open your editor
via Vite), its primitive's sibling nodes, and both directions of its dependencies.

---

## 🏷️ Names come from your code

On the dev server, the compiler passes every declared identifier through automatically:
`state count`, `form login`, `resource user` label their nodes with no configuration, and
`with { name: '...' }` overrides the label on any keyword. In plain TS, pass `{ name }` to
`createSignal`/`createResource`/`createForm`/`createStore` and friends for the same labels.
Production output carries none of this.

---

## 🖥️ Inspecting the server

Requests on an AzerothJS backend are reactive roots, so the SAME inspector reads the
server's graph. Attach the dev-only bridge next to `serve()`:

```ts
import { serve } from '@azerothjs/http/node';
import { attachDevtools } from '@azerothjs/devtools/server';

const served = await serve(handler, { port: 5200 });
if (process.env.NODE_ENV !== 'production')
{
    attachDevtools(served.server); // ws endpoint at /__azeroth/devtools
}
```

The panel's Server tab connects to it (`installDevtools({ server })` seeds the URL; the tab
remembers whatever you enter) and mirrors the server's components view live: request roots,
their per-request state and effects, and long-lived server stores. `attachDevtools` throws
under `NODE_ENV=production` so it cannot ship by accident, and by default only accepts
browser connections from localhost origins - the graph carries live values, so treat the
bridge like a debugger port. Logs and traces stay [`@azerothjs/logger`](../logger)'s job.

---

## 🔌 The agent (headless use)

The panel is one consumer of the agent - the piece that installs the runtime hook and keeps
the model. Drive it yourself for a custom overlay, a test harness, or an extension
transport:

```ts
import { createAgent } from '@azerothjs/devtools';

const agent = createAgent();
agent.subscribe(() => console.log(agent.getModel().counts));
agent.handle({ kind: 'peek', id: 42 }); // JSON-serializable request/response boundary
```

Everything the agent returns is JSON-serializable: `getModel()`, `getGraph()`,
`getTimeline()`, `getHealth()`, `exportSession()`, and per-node `peek`/`poke`/`getHistory`.

---

## 🔗 Related

Part of the [AzerothJS](../../README.md) monorepo. Related packages:
[`azerothjs`](../azerothjs) (the runtime whose versioned hook this consumes),
[`@azerothjs/http`](../http) (the backend whose requests the Server tab inspects), and
[`@azerothjs/ws`](../ws) (the WebSocket layer under the bridge).

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
