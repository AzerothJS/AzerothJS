// Declaration-emit corpus benchmark (v1 unit 6.5). Generates a 120-component corpus
// (components importing azerothjs, using state/derived/effect + builtins, plus a
// cross-import chain) and measures emitDeclarationsWithMap over every file - the exact
// loop the vite emitDeclarations mirror runs. Run BEFORE and AFTER the shared-host
// change; compare wall totals.
//
//   node perf/decl-corpus-bench.mjs
//
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, '.decl-corpus');
const COUNT = 120;

rmSync(corpusDir, { recursive: true, force: true });
mkdirSync(corpusDir, { recursive: true });

for (let i = 0; i < COUNT; i++)
{
    const prev = i > 0 ? `import Prev${ i - 1 } from './C${ i - 1 }.azeroth';\n` : '';
    const prevTag = i > 0 ? `<Prev${ i - 1 } label={label} />` : '<span>root</span>';
    writeFileSync(join(corpusDir, `C${ i }.azeroth`), `${ prev }
export default component C${ i }(props: { label?: string })
{
    state count = ${ i };
    derived doubled = count * 2;
    const label = props.label ?? 'c${ i }';
    effect { console.log(label, doubled); }
    <section class="c${ i }">
        <h2>{label}</h2>
        <For each={[1, 2, 3]} key={(n) => n}>
            {(n) => <p>{n + count}</p>}
        </For>
        ${ prevTag }
    </section>
}
`);
}

const { emitDeclarationsWithMap } = await import('../packages/compiler/src/declarations.ts');
const { readFileSync } = await import('node:fs');

// Warm-up on one file so one-time costs (first lib parse) are excluded from the
// per-corpus story only if BOTH runs get them; keep it IN for honesty - the mirror
// pays it once per build too. We report cold total + warm re-run.
const files = Array.from({ length: COUNT }, (_, i) => join(corpusDir, `C${ i }.azeroth`));

function pass()
{
    const t0 = performance.now();
    let bytes = 0;
    for (const file of files)
    {
        const out = emitDeclarationsWithMap(readFileSync(file, 'utf8'), file);
        bytes += out.dts.length;
        if (out.dts.length === 0)
        {
            throw new Error(`empty d.ts for ${ file }`);
        }
    }
    return { ms: performance.now() - t0, bytes };
}

const cold = pass();
const warm = pass();
console.log(`corpus: ${ COUNT } components (chained imports)`);
console.log(`cold pass: ${ cold.ms.toFixed(0) } ms  (${ (cold.ms / COUNT).toFixed(1) } ms/file, ${ cold.bytes } dts bytes)`);
console.log(`warm pass: ${ warm.ms.toFixed(0) } ms  (${ (warm.ms / COUNT).toFixed(1) } ms/file)`);

rmSync(corpusDir, { recursive: true, force: true });
