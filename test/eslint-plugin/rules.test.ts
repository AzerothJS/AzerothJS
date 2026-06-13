// The ESLint rules, driven through eslint's own RuleTester: each fires on
// its target foot-gun and stays silent on the legitimate look-alikes.

import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { rules } from '@azerothjs/eslint-plugin';

const tester = new RuleTester({
    languageOptions:
    {
        ecmaVersion: 2022,
        sourceType: 'module'
    }
});

describe('azeroth/no-self-write-in-effect', () =>
{
    it('flags the synchronous feedback loop and permits untrack/distinct signals', () =>
    {
        tester.run('no-self-write-in-effect', rules['no-self-write-in-effect'], {
            valid:
            [
                // Reads one signal, writes another.
                `const [a] = createSignal(0);
                 const [b, setB] = createSignal(0);
                 createEffect(() => { setB(a() + 1); });`,

                // The write is untracked - the documented escape hatch.
                `const [n, setN] = createSignal(0);
                 createEffect(() => { n(); untrack(() => setN(1)); });`,

                // Write without a read of the same signal.
                `const [n, setN] = createSignal(0);
                 createEffect(() => { setN(1); });`,

                // Same pattern outside any effect.
                `const [n, setN] = createSignal(0);
                 function bump() { setN(n() + 1); }`
            ],
            invalid:
            [
                {
                    code: `const [n, setN] = createSignal(0);
                           createEffect(() => { setN(n() + 1); });`,
                    errors: [{ messageId: 'selfWrite' }]
                },
                {
                    // Nested in a branch, still the same loop.
                    code: `const [open, setOpen] = createSignal(false);
                           createEffect(() => { if (open()) { setOpen(false); } });`,
                    errors: [{ messageId: 'selfWrite' }]
                }
            ]
        });
    });
});

describe('azeroth/require-effect-disposal', () =>
{
    it('flags module-scope discarded effects only', () =>
    {
        tester.run('require-effect-disposal', rules['require-effect-disposal'], {
            valid:
            [
                // Disposer kept.
                'const dispose = createEffect(() => {});',

                // Inside a function: ownership is the surrounding scope's
                // business (components run under render()'s root).
                'function setup() { createEffect(() => {}); }',

                // Inside createRoot.
                'createRoot(() => { createEffect(() => {}); });'
            ],
            invalid:
            [
                {
                    code: 'createEffect(() => {});',
                    errors: [{ messageId: 'naked' }]
                }
            ]
        });
    });
});

describe('azeroth/handler-call', () =>
{
    it('flags zero-arg handler calls in h() props, permits refs/arrows/factories', () =>
    {
        tester.run('handler-call', rules['handler-call'], {
            valid:
            [
                "h('button', { onClick: save }, 'go');",
                "h('button', { onClick: () => save() }, 'go');",
                // Factory idiom: a call WITH arguments.
                "h('button', { onClick: makeHandler(id) }, 'go');",
                // Not an event prop.
                "h('input', { value: read() });",
                // Not an h() call.
                "other('button', { onClick: save() });"
            ],
            invalid:
            [
                {
                    code: "h('button', { onClick: save() }, 'go');",
                    errors: [{ messageId: 'called' }]
                },
                {
                    code: "h('form', { onSubmit: actions.reset() });",
                    errors: [{ messageId: 'called' }]
                }
            ]
        });
    });
});
