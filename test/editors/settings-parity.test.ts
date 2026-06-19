// Guards that BOTH editors expose every per-feature toggle the server actually
// gates, so the user-facing config surface can't silently drift from the server.
// (This suite exists because JetBrains had drifted - it was missing toggles for
// callHierarchy, codeLens, documentLinks, and documentColor.) The canonical list
// is the server's own FeatureToggles, read at runtime via parseSettings.

import { describe, it, expect } from 'vitest';
import { parseSettings } from '@azerothjs/language-server';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FEATURES = Object.keys(parseSettings(undefined).features);

describe('editor settings parity', () =>
{
    it('the server exposes a non-trivial set of feature toggles', () =>
    {
        // Sanity check so a refactor that empties `features` doesn't make the
        // parity assertions below vacuously pass.
        expect(FEATURES.length).toBeGreaterThanOrEqual(20);
    });

    it('VS Code declares an enable setting for every server feature', () =>
    {
        const pkg = JSON.parse(readFileSync(path.join(ROOT, 'editors/vscode/package.json'), 'utf8'));
        const props = pkg.contributes.configuration.properties as Record<string, unknown>;
        const missing = FEATURES.filter(feature => !(`azeroth.${ feature }.enable` in props));
        expect(missing).toEqual([]);
    });

    it('JetBrains persists AND forwards every server feature', () =>
    {
        const kt = readFileSync(
            path.join(ROOT, 'editors/jetbrains/src/main/kotlin/com/azerothjs/AzerothSettings.kt'),
            'utf8'
        );
        // Each feature must be a persisted State field and a key in the
        // `azeroth.*` tree sent to the server (toInitializationOptions).
        const missingField = FEATURES.filter(feature => !new RegExp(`var ${ feature }\\b`).test(kt));
        const missingForward = FEATURES.filter(feature => !kt.includes(`"${ feature }" to mapOf("enable"`));
        expect({ missingField, missingForward }).toEqual({ missingField: [], missingForward: [] });
    });
});
