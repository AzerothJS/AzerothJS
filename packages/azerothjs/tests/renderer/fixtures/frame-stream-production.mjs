// The production-mode streamed-keep arm's child body: a frame-owning streamed host that yields
// past the measured loss window must keep its own head and styles - under
// NODE_ENV=production, against the BUILT dist, where the old loss was silent.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const dist = (rel) => pathToFileURL(join(repo, rel)).href;

if (process.env.NODE_ENV !== 'production')
{
    console.log(JSON.stringify({ error: `NODE_ENV is '${ process.env.NODE_ENV }'` }));
    process.exit(1);
}

const azeroth = await import(dist('packages/azerothjs/dist/index.js'));
const { Suspense, createRenderFrame, createResource, collectStyleSheet, css, h, renderToStream } = azeroth;
const { collectHead } = await import(dist('packages/azerothjs/dist/internal.js'));

const frame = createRenderFrame();
const stream = renderToStream(() =>
{
    azeroth.useHead({ title: 'PROD-STREAM-TITLE' });
    css(['.prod-stream-arm { color: rgb(4, 5, 6); }']);
    const resource = createResource(() => Promise.resolve('fast'));
    return Suspense({
        fallback: () => h('i', {}, 'loading'),
        on: [resource],
        children: () => h('b', {}, resource.data() ?? '')
    });
}, { frame });

// Yield a macrotask - well past the 4-tick loss window - so the fast boundary's
// continuation runs and discards its own frame before the host drains.
await new Promise((resolve) => setTimeout(resolve, 30));
const styles = collectStyleSheet(frame);
const head = collectHead({ frame });
await stream.getReader().cancel();

console.log(JSON.stringify({
    title: head.titleText,
    cssPresent: styles.includes('prod-stream-arm')
}));
