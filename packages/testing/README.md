<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/testing

**AzerothJS testing utilities - auto-disposing mounts, subscriber leak guards, event helpers**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Ftesting?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/testing)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Test helpers for [`azerothjs`](https://www.npmjs.com/package/azerothjs) apps: auto-disposing mounts, subscriber leak guards, and a bubbling-event helper. Install as a dev dependency alongside the framework.

```ts
import { renderTest, leakGuard, fire, cleanup } from '@azerothjs/testing';
import { createSignal, h } from 'azerothjs';

it('updates and tears down cleanly', () =>
{
    const [count, setCount] = createSignal(0);
    const check = leakGuard(count);

    const { container, unmount } = renderTest(() =>
        h('p', {}, () => `count: ${ count() }`));

    expect(container.textContent).toBe('count: 0');
    setCount(1);
    expect(container.textContent).toBe('count: 1');

    unmount();
    check(); // throws if any subscription survived the unmount
});
```

- `renderTest(component)` mounts into a fresh container in `document.body`
  (attached, so delegated events from compiled `dom`-target code fire) and
  returns `{ container, unmount }`.
- `cleanup()` unmounts everything still mounted. With a test runner whose
  globals are enabled (vitest `globals: true`, jest) it registers itself in
  `afterEach` automatically at import time; otherwise call it from your own
  `afterEach`.
- `leakGuard(...getters)` snapshots subscriber counts and returns an
  assertion that throws if teardown left subscriptions behind.
- `fire(el, type, init?)` dispatches a bubbling, cancelable event.

---

## 📦 Install

> [!NOTE]
> ESM-only, Node >= 22. `azerothjs` is a required peer - the helpers mount and inspect its reactive trees:

```sh
npm install -D @azerothjs/testing azerothjs
```

---

## 🔗 Related

- [AzerothJS](../../README.md) - the monorepo overview and the full package list.
- [`azerothjs`](../azerothjs) - the framework runtime these helpers mount and inspect (required peer).
- [`@azerothjs/kit`](../kit) - per-route SSR, prerendering, and hydration for fullstack apps.

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
