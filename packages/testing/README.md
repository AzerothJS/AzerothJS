<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/testing

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Ftesting?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/testing)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

Testing utilities for AzerothJS apps: auto-disposing mounts, subscriber
leak guards, and a bubbling-event helper.

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

## Install

```sh
npm install -D @azerothjs/testing
```

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
