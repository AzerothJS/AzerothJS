// @vitest-environment node
//
// The four FACTORY keywords - resource / stream / store / selector - are declaration sugar for the
// raw create* calls. Unlike state/derived/deferred (read plain, rewritten to a getter call) they return
// an object or a function read EXPLICITLY (user.data(), cart.items(), isActive(key)), so they lower to a
// plain `const NAME = createX(...)` in BOTH codegen and the projection (the projection emits the real
// call so TypeScript infers Resource<T> / Stream<T> / the store / the selector). A `with { source }`
// clause becomes the leading source getter for resource/stream; the rest are the trailing options.
import { describe, it, expect } from 'vitest';
import { generateVirtualCode } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';

const code = (src: string): string => generateModule(`component A {\n${ src }\n<p>{ok}</p>\n}`).code;
const proj = (src: string): string => generateVirtualCode(`component A {\n${ src }\n<p>{ok}</p>\n}`).code;

describe('resource keyword', () =>
{
    it('source-driven: with { source } becomes the leading source getter', () =>
    {
        const out = code('state id = 1;\nresource user = (n: number) => fetchUser(n) with { source: id };');
        expect(out).toContain('createResource(() => (id()), (n: number) => fetchUser(n))');
        expect(out).toContain('createResource'); // auto-imported
    });

    it('standalone: no source argument', () =>
    {
        expect(code('resource config = () => fetchConfig();')).toContain('createResource(() => fetchConfig())');
    });

    it('projection types it as the real createResource call (so NAME.data() checks)', () =>
    {
        const out = proj('state id = 1;\nresource user = (n: number) => fetchUser(n) with { source: id };');
        // projection reads the source PLAIN (no getter-call rewrite) and declares the runtime helper
        expect(out).toContain('const user = createResource(() => (id), (n: number) => fetchUser(n))');
        expect(out).toContain("declare const createResource: typeof import('azerothjs').createResource;");
    });
});

describe('stream keyword', () =>
{
    it('splits source from the trailing stream options', () =>
    {
        const out = code('state id = 1;\nstream feed = (n: number) => open(n) with { source: id, parse: "json" };');
        expect(out).toContain('createStream(() => (id()), (n: number) => open(n), { parse: "json" })');
    });
});

describe('store keyword', () =>
{
    it('wraps a bare object literal in a factory', () =>
    {
        expect(code('store cart = { items: [] as number[] };')).toContain('createStore(() => ({ items: [] as number[] }))');
    });

    it('passes an arrow factory through unchanged', () =>
    {
        expect(code('store cart = () => ({ items: [] as number[] });')).toContain('createStore(() => ({ items: [] as number[] }))');
    });
});

describe('selector keyword', () =>
{
    it('the value is the source; the with-clause is the options', () =>
    {
        const out = code('state sel = 0;\nselector isActive = sel with { equals: Object.is };');
        expect(out).toContain('createSelector(() => (sel()), { equals: Object.is })');
    });
});

describe('factory keywords are not reactive sources', () =>
{
    it('a read of a factory name is NOT rewritten to a getter call', () =>
    {
        // `user` is a resource; reading `user.data()` must stay `user.data()`, never `user().data()`.
        const out = code('resource user = () => fetchUser();\nderived label = user.loading() ? "..." : "ok";');
        expect(out).toContain('user.loading()');
        expect(out).not.toContain('user().loading()');
    });
});
