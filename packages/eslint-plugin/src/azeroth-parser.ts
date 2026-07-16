// The `.azeroth` ESLint parser.
//
// It is set as `languageOptions.parser` for the processor's virtual `.ts` blocks. The processor has
// already lowered the `.azeroth` file to its virtual TypeScript (the block text); this parser parses
// that text in PROGRAM mode against the shared AzerothProject's program (see project-pool.ts). The
// result therefore carries real `parserServices` (`program` + `getTypeChecker` + the ESTree<->TS node
// map), which is what lets type-aware `@typescript-eslint` rules - `no-floating-promises`,
// `strict-boolean-expressions`, `no-misused-promises`, ... - run on `.azeroth` exactly as on `.ts`.
//
// Node ranges stay in virtual coordinates here; the processor's `postprocess` maps every message and
// fix back to the original `.azeroth` source and drops anything in generated scaffolding. So this
// parser stays small: its whole job is to attach the right program to the right virtual file.

import tsParser from '@typescript-eslint/parser';
import { posix } from 'node:path';
import { toVirtualFile } from '@azerothjs/language-service';
import { projectFor, normalize } from './project-pool.ts';

interface ParserOptions
{
    filePath?: string;
    [key: string]: unknown;
}

/** ESLint custom-parser entry. `code` is the virtual block; `options.filePath` is `<file>.azeroth/0.ts`. */
export function parseForESLint(code: string, options: ParserOptions = {}): ReturnType<typeof tsParser.parseForESLint>
{
    // The block lives at `<azeroth-file>/0.ts`, so its directory IS the `.azeroth` path the processor
    // registered in the pool. The program holds that file under its virtual twin name.
    const azerothPath = posix.dirname(normalize(options.filePath ?? ''));
    const project = projectFor(azerothPath);
    const program = project.service.getProgram();
    const twin = toVirtualFile(azerothPath);

    // Program mode (reusing the LS program) when the twin is in it - that is the type-aware path. If for
    // any reason it isn't (e.g. a file linted without the processor having registered it), fall back to
    // a syntactic parse so linting still works, just without type information.
    //
    // `project` and `projectService` are forced off REGARDLESS of what the surrounding config set: if the
    // user enabled `projectService: true` (or a `project`) for their `.ts` files, inheriting it here would
    // make typescript-estree build its own inferred project and ignore our `programs`, silently degrading
    // every type to `any` so type-aware rules find nothing. We always drive types from the LS program.
    if (program !== undefined && program.getSourceFile(twin) !== undefined)
    {
        return tsParser.parseForESLint(code, { ...options, programs: [program], filePath: twin, project: null, projectService: false });
    }
    return tsParser.parseForESLint(code, { ...options, project: null, projectService: false });
}

/** The parser object for `languageOptions.parser`. */
export const azerothParser: { meta: { name: string; version: string }; parseForESLint: typeof parseForESLint } =
{
    meta: { name: '@azerothjs/eslint-plugin/parser', version: '0.6.0-beta.1' },
    parseForESLint
};
