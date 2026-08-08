// @vitest-environment node
//
// An overlay file that also exists in its base template is a COPY, and a copy drifts. When the
// guest book moved to a server action the base template was updated and the tailwind overlay's
// copy of the same page was not, so `create-azeroth --template fullstack --tailwind` produced a
// project that failed its own `npm run check` on the first try - while every repo gate stayed
// green, because nothing here is linted, typechecked, or scaffolded by CI.
//
// Overlays legitimately differ in PRESENTATION (class attributes, markup shape). What they must
// not do is drift in BEHAVIOR, so this checks the load-bearing call shapes rather than diffing
// whole files - a strict diff would fail on every restyle and get deleted within a week.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Overlay directory -> the template whose files it overlays. */
const OVERLAY_BASES: ReadonlyArray<{ overlay: string; base: string }> = [
    { overlay: 'overlays/fullstack/tailwind', base: 'templates/fullstack' },
    { overlay: 'overlays/frontend/router', base: 'templates/frontend' },
    { overlay: 'overlays/frontend/tailwind', base: 'templates/frontend' },
    { overlay: 'overlays/frontend/router-tailwind', base: 'templates/frontend' }
];

/**
 * Behavioral signatures: a call shape that must appear in an overlay copy whenever it appears
 * in the base. Each is an API contract - getting it wrong does not merely look different, it
 * fails to compile or silently drops a feature.
 */
const SIGNATURES: ReadonlyArray<{ pattern: RegExp; what: string }> = [
    { pattern: /\bclient\.\w+\.\w+\([^)]*\binput:/, what: 'legacy { input: ... } client call (server actions take the input directly)' },
    { pattern: /\bapplyFieldErrors\(/, what: 'applyFieldErrors error mapping' },
    { pattern: /<Image\b/, what: '<Image> usage' }
];

function filesIn(root: string): string[]
{
    const out: string[] = [];
    const walk = (dir: string): void =>
    {
        for (const entry of readdirSync(dir))
        {
            const full = join(dir, entry);
            if (statSync(full).isDirectory())
            {
                walk(full);
            }
            else if (entry.endsWith('.azeroth') || entry.endsWith('.ts'))
            {
                out.push(full);
            }
        }
    };
    walk(root);
    return out;
}

describe('overlay copies stay behaviorally in sync with their base template', () =>
{
    const pairs: Array<[string, string, string]> = [];
    for (const { overlay, base } of OVERLAY_BASES)
    {
        const overlayRoot = join(PACKAGE_ROOT, overlay);
        if (!existsSync(overlayRoot))
        {
            continue;
        }
        for (const file of filesIn(overlayRoot))
        {
            const rel = relative(overlayRoot, file).replaceAll('\\', '/');
            const baseFile = join(PACKAGE_ROOT, base, rel);
            if (existsSync(baseFile))
            {
                pairs.push([`${ overlay }/${ rel }`, file, baseFile]);
            }
        }
    }

    it('finds overlay/base file pairs to compare', () =>
    {
        expect(pairs.length).toBeGreaterThan(3);
    });

    it.each(pairs)('%s matches its base on every behavioral signature', (_label, overlayFile, baseFile) =>
    {
        const overlaySource = readFileSync(overlayFile, 'utf8');
        const baseSource = readFileSync(baseFile, 'utf8');
        const drift = SIGNATURES
            .filter((signature) => signature.pattern.test(baseSource) !== signature.pattern.test(overlaySource))
            .map((signature) => `${ signature.what }: base=${ signature.pattern.test(baseSource) } overlay=${ signature.pattern.test(overlaySource) }`);
        expect(drift).toEqual([]);
    });
});
