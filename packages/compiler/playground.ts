// ============================================================================
// AZEROTHJS COMPILER — Playground
// ============================================================================
//
// See the compiler in action: prints each .azeroth file's source
// next to the h() code it compiles to.
//
//   npx tsx packages/compiler/playground.ts
//   npx tsx packages/compiler/playground.ts path/to/MyComp.azeroth
//
// ============================================================================

import { readFileSync } from 'node:fs';
import { compile } from './src/index.ts';

const args = process.argv.slice(2);
const targets = args.length > 0
    ? args
    : ['packages/compiler/examples/Todo.azeroth', 'packages/compiler/examples/Clock.azeroth'];

const bar = '═'.repeat(72);

for (const file of targets)
{
    const source = readFileSync(file, 'utf8');
    const { code } = compile(source);

    console.log(`\n${ bar }\n  ${ file }  →  compiled\n${ bar }\n`);
    console.log(code);
}
