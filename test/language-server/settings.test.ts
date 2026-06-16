// The language server exposes every LSP feature as an independent toggle
// (`azeroth.<feature>.enable`). parseSettings resolves a partial/absent client
// config into a complete, defaulted settings object - on unless explicitly
// false - so the handlers can gate per feature. These tests pin that contract.

import { describe, it, expect } from 'vitest';
import { parseSettings, type FeatureToggles } from '@azerothjs/language-server';

const FEATURE_KEYS: (keyof FeatureToggles)[] = [
    'completion', 'hover', 'definition', 'typeDefinition', 'references',
    'documentHighlight', 'rename', 'documentSymbol', 'workspaceSymbol',
    'signatureHelp', 'semanticTokens', 'codeActions', 'folding',
    'selectionRange', 'onTypeFormatting', 'linkedEditing',
    'callHierarchy', 'codeLens', 'documentLinks', 'documentColor'
];

describe('parseSettings - per-feature toggles', () =>
{
    it('defaults every feature ON for an empty/absent config', () =>
    {
        for (const cfg of [undefined, {}, { unrelated: 1 }])
        {
            const { features } = parseSettings(cfg);
            for (const key of FEATURE_KEYS)
            {
                expect(features[key], `${ key } should default on`).toBe(true);
            }
        }
    });

    it('disables exactly the feature whose `enable` is false, leaving the rest on', () =>
    {
        const { features } = parseSettings({
            completion: { enable: false },
            semanticTokens: { enable: false }
        });
        expect(features.completion).toBe(false);
        expect(features.semanticTokens).toBe(false);
        for (const key of FEATURE_KEYS)
        {
            if (key !== 'completion' && key !== 'semanticTokens')
            {
                expect(features[key], `${ key } should stay on`).toBe(true);
            }
        }
    });

    it('treats only an explicit `false` as off (truthy/missing stays on)', () =>
    {
        expect(parseSettings({ hover: { enable: true } }).features.hover).toBe(true);
        expect(parseSettings({ hover: {} }).features.hover).toBe(true);
        expect(parseSettings({ hover: { enable: false } }).features.hover).toBe(false);
    });

    it('still resolves the pre-existing settings (diagnostics, format, inlayHints)', () =>
    {
        const s = parseSettings({ diagnostics: { enable: false }, format: { enable: false } });
        expect(s.diagnostics.enable).toBe(false);
        expect(s.format.enable).toBe(false);
        expect(s.inlayHints.enabled).toBe(true);
        expect(s.suggest.autoImports).toBe(true);
    });
});
