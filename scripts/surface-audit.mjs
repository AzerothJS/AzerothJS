// Public-surface audit: which exported symbols can no consumer reach?
//
// WHY THIS EXISTS, AND WHY IT IS NOT A GREP.
//
// The obvious way to answer "is this export used" is to search for its name. That answer is wrong
// in a way that deletes working code, because an export can have zero importers and still be
// load-bearing: it may be a MEMBER of a type another package does import. Nothing names
// `MarkupAttribute`, but `MarkupElement.attributes` is `MarkupAttribute[]` and two packages import
// `MarkupElement`, so a consumer annotating what it already receives needs it.
//
// Two hand-written reachability scripts were tried before this one. Both concluded "delete all 25
// candidates", including `MarkupAttribute` and `Span`. Both were wrong. Text analysis cannot see
// through `extends`, through a generic argument, or through a re-export, so this uses the
// TypeScript checker to resolve every type reference to the declaration it actually names.
//
// The tool asserts its own correctness before reporting: KNOWN_REACHABLE below lists symbols whose
// answer is established by reading the source, and the audit fails loudly if it disagrees. A tool
// that recommends deletions has to prove it can be trusted first.
//
// Usage: node scripts/surface-audit.mjs [packageName ...]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Ground truth, read by hand from the source. Each entry is a symbol that MUST come out reachable;
 * if the analysis says otherwise it is broken and must not be believed.
 */
const KNOWN_REACHABLE = [
    // `export interface MarkupElement extends Span { attributes: MarkupAttribute[] }`, and
    // MarkupElement is imported by @azerothjs/language-server and @azerothjs/eslint-plugin.
    { package: '@azerothjs/compiler', symbol: 'MarkupAttribute', via: 'MarkupElement.attributes' },
    { package: '@azerothjs/compiler', symbol: 'Span', via: 'MarkupElement extends Span' },
    { package: '@azerothjs/compiler', symbol: 'MarkupChild', via: 'MarkupElement.children' }
];

/**
 * Entries whose consumers import reachability cannot see. Their rows are reported separately:
 * an "unreachable" count there is a property of the measurement, not of the surface.
 */
const UNMEASURABLE = new Map([
    ['azerothjs/internal', 'codegen target: consumers are compiler-GENERATED modules; RUNTIME_CONTRACT_VERSION keeps it in lockstep, not imports'],
    ['@azerothjs/eslint-plugin', 'consumed from eslint.config.js files - JavaScript, outside the scan'],
    ['@azerothjs/cli', 'a binary: reached through the azeroth bin, not imports'],
    ['@azerothjs/language-server', 'a binary: the LSP server entry editors spawn, not import'],
    ['@azerothjs/language-server/tsc', 'the azeroth-tsc bin implementation'],
    ['@azerothjs/language-server/docgen', 'the docgen bin implementation']
]);

/**
 * Real applications built ON the framework, outside this repository. They import by package name,
 * which is exactly the signal the audit needs: the in-repo packages mostly consume each other by
 * relative path, so without these roots the application-facing surface of `azerothjs` and
 * `@azerothjs/http` would look unused. Missing directories are skipped.
 */
const EXTERNAL_CONSUMERS = [
    join(process.env.TEMP ?? '', 'azvalidation'),
    join(process.env.TEMP ?? '', 'apireview'),
    join(process.env.TEMP ?? '', 'chat'),
    resolve(ROOT, '..', 'nura-chain', 'server'),
    resolve(ROOT, '..', 'Euphoria', 'server'),
    resolve(ROOT, '..', 'Website'),
    resolve(ROOT, '..', 'AzerothFolio')
];

/** Packages whose entry points are audited, mapped to their published entry sources. */
function entryPoints()
{
    const out = [];
    for (const name of readdirSync(join(ROOT, 'packages')))
    {
        const dir = join(ROOT, 'packages', name);
        if (!statSync(dir).isDirectory())
        {
            continue;
        }

        let manifest;
        try
        {
            manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        }
        catch
        {
            continue;
        }
        if (manifest.exports === undefined)
        {
            continue;
        }

        for (const [subpath, target] of Object.entries(manifest.exports))
        {
            const dist = typeof target === 'string' ? target : target.import ?? target.default;
            if (typeof dist !== 'string' || !dist.endsWith('.js'))
            {
                continue;
            }
            // dist/api/index.js -> src/api/index.ts
            const source = join(dir, dist.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));
            try
            {
                statSync(source);
            }
            catch
            {
                continue;
            }
            out.push({ package: manifest.name, subpath, source });
        }
    }
    return out;
}

/** Every source file under a directory matching one of the extensions. */
function walk(dir, extensions, out = [])
{
    for (const entry of readdirSync(dir))
    {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.git')
        {
            continue;
        }
        const full = join(dir, entry);
        if (statSync(full).isDirectory())
        {
            walk(full, extensions, out);
        }
        else if (extensions.some((ext) => full.endsWith(ext)) && !full.endsWith('.d.ts'))
        {
            out.push(full);
        }
    }
    return out;
}

/**
 * Which exported names each consumer actually imports, per entry.
 *
 * This half IS a scan, and that is sound: its answer is a list of files anyone can open and check,
 * unlike a reachability claim. It only decides where the walk STARTS - anything those symbols
 * transitively reference is found by the checker below.
 */
function importedNames(files, entries)
{
    const byEntry = new Map(entries.map((entry) => [`${ entry.package }${ entry.subpath.slice(1) }`, new Set()]));

    for (const file of files)
    {
        const source = readFileSync(file, 'utf8');
        // `[^}]*` cannot cross a closing brace, so one match is exactly one import statement - the
        // constraint a previous attempt lacked, which let a match span two imports. The specifier
        // must match an entry EXACTLY: substring matching credited `@azerothjs/http` imports to
        // `azerothjs` too, which once inflated an entry to more seeds than it has exports.
        for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g))
        {
            const names = byEntry.get(match[2]);
            if (names === undefined)
            {
                continue;
            }
            for (let name of match[1].split(','))
            {
                name = name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
                if (name !== '')
                {
                    names.add(name);
                }
            }
        }
    }
    return byEntry;
}

/** The declaration nodes a symbol owns, following aliases to the real declaration. */
function declarationsOf(checker, symbol)
{
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    return target.declarations ?? [];
}

/**
 * Every symbol a declaration REFERENCES, resolved by the checker.
 *
 * Type references, heritage clauses (`extends`), generic arguments and property types all resolve
 * through `getSymbolAtLocation`, so `extends Span` and `MarkupAttribute[]` are both found - the two
 * shapes text matching missed.
 */
function referencedSymbols(checker, declaration)
{
    const found = new Set();
    const visit = (node) =>
    {
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node))
        {
            const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
            const symbol = checker.getSymbolAtLocation(name);
            if (symbol !== undefined)
            {
                found.add((symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    return found;
}

function audit(only)
{
    const entries = entryPoints().filter((entry) => only.length === 0 || only.includes(entry.package));

    // The checker program only needs in-repo sources; external applications join the IMPORT scan
    // (they seed reachability by name) but are not typechecked here - their configs are their own.
    const inRepo = walk(join(ROOT, 'packages'), ['.ts']).concat(
        existsSync(join(ROOT, 'editors')) ? walk(join(ROOT, 'editors'), ['.ts']) : []
    );
    const scanned = [...inRepo];
    for (const dir of EXTERNAL_CONSUMERS)
    {
        if (existsSync(dir))
        {
            walk(dir, ['.ts', '.tsx', '.azeroth'], scanned);
        }
    }

    const program = ts.createProgram({
        rootNames: [...new Set([...inRepo, ...entries.map((entry) => entry.source)])],
        options: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            allowImportingTsExtensions: true,
            noEmit: true,
            skipLibCheck: true,
            strict: true
        }
    });
    const checker = program.getTypeChecker();
    const imported = importedNames(scanned, entries);

    const report = [];
    for (const entry of entries)
    {
        const file = program.getSourceFile(entry.source);
        if (file === undefined)
        {
            continue;
        }
        const moduleSymbol = checker.getSymbolAtLocation(file);
        if (moduleSymbol === undefined)
        {
            continue;
        }

        const exported = checker.getExportsOfModule(moduleSymbol);
        const byName = new Map(exported.map((symbol) => [symbol.name, symbol]));
        const seedNames = imported.get(`${ entry.package }${ entry.subpath.slice(1) }`) ?? new Set();

        // Seed with everything a consumer names, then close over what those declarations reference.
        const reachable = new Set();
        const frontier = [];
        for (const name of seedNames)
        {
            const symbol = byName.get(name);
            if (symbol !== undefined)
            {
                const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
                reachable.add(target);
                frontier.push(target);
            }
        }
        while (frontier.length > 0)
        {
            for (const declaration of declarationsOf(checker, frontier.pop()))
            {
                for (const next of referencedSymbols(checker, declaration))
                {
                    if (!reachable.has(next))
                    {
                        reachable.add(next);
                        frontier.push(next);
                    }
                }
            }
        }

        const unreachable = exported
            .filter((symbol) =>
            {
                const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
                return !reachable.has(target) && !seedNames.has(symbol.name);
            })
            .map((symbol) => symbol.name)
            .sort();

        report.push({ ...entry, total: exported.length, seeded: seedNames.size, unreachable });
    }
    return report;
}

const only = process.argv.slice(2);
const report = audit(only);

// Self-check FIRST: a tool that recommends deletions proves it can be trusted before it reports.
const broken = [];
for (const known of KNOWN_REACHABLE)
{
    const rows = report.filter((r) => r.package === known.package);
    if (rows.length === 0)
    {
        continue;
    }
    if (rows.some((r) => r.unreachable.includes(known.symbol)))
    {
        broken.push(known);
    }
}

if (broken.length > 0)
{
    process.stderr.write('\nsurface-audit: SELF-CHECK FAILED - the analysis is wrong, do not act on it.\n\n');
    for (const item of broken)
    {
        process.stderr.write(`  ${ item.package } "${ item.symbol }" reported unreachable, but ${ item.via }\n`);
    }
    process.stderr.write('\n');
    process.exit(1);
}

let totalUnreachable = 0;
let measured = 0;
for (const row of report.sort((first, second) => second.unreachable.length - first.unreachable.length))
{
    const entry = `${ row.package }${ row.subpath.slice(1) }`;
    if (UNMEASURABLE.has(entry))
    {
        continue;
    }
    measured += 1;
    totalUnreachable += row.unreachable.length;
    console.log(`${ entry }`);
    console.log(`  exported ${ row.total } | named by a consumer ${ row.seeded } | unreachable ${ row.unreachable.length }`);
    if (row.unreachable.length > 0)
    {
        console.log(`  ${ row.unreachable.join(', ') }`);
    }
    console.log('');
}

console.log('not measurable by import reachability:');
for (const [entry, reason] of UNMEASURABLE)
{
    console.log(`  ${ entry } - ${ reason }`);
}
console.log('');
console.log(`self-check passed (${ KNOWN_REACHABLE.length } known-reachable symbols); ${ totalUnreachable } unreachable exports across ${ measured } measurable entry points`);
console.log('NOTE: unreachable is not the same as deletable - an export can be vocabulary an');
console.log('application needs but this repo does not, or reachable from markup without an import.');
