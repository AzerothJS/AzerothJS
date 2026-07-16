// @vitest-environment node
//
// parseSettings: the pure resolver from a client's raw `azeroth.*` config blob
// to a complete AzerothSettings. The contract under guard: every value is ON
// unless explicitly `false`, malformed shapes fall back to defaults, and the
// resolver never throws - it runs on every configuration push from the editor.

import { describe, it, expect } from 'vitest';

import { parseSettings } from '../src/server.ts';

describe('parseSettings', () =>
{
    it('resolves an absent config to everything on', () =>
    {
        const settings = parseSettings(undefined);
        expect(settings.diagnostics.enable).toBe(true);
        expect(settings.format.enable).toBe(true);
        expect(settings.autoClosingTags).toBe(true);
        expect(settings.suggest).toEqual({ autoImports: true, componentSnippets: true });
        expect(Object.values(settings.features).every((on) => on)).toBe(true);
        expect(settings.inlayHints).toEqual({
            enabled: true,
            parameterNames: 'all',
            parameterTypes: true,
            variableTypes: true,
            propertyDeclarationTypes: true,
            functionLikeReturnTypes: true,
            enumMemberValues: true
        });
    });

    it('turns off exactly what is explicitly false, leaving neighbours on', () =>
    {
        const settings = parseSettings({
            diagnostics: { enable: false },
            hover: { enable: false },
            suggest: { autoImports: false },
            autoClosingTags: false,
            inlayHints: { enabled: false, parameterNames: 'none' }
        });
        expect(settings.diagnostics.enable).toBe(false);
        expect(settings.features.hover).toBe(false);
        expect(settings.autoClosingTags).toBe(false);
        expect(settings.suggest.autoImports).toBe(false);
        expect(settings.inlayHints.enabled).toBe(false);
        expect(settings.inlayHints.parameterNames).toBe('none');
        // Untouched neighbours keep their defaults.
        expect(settings.format.enable).toBe(true);
        expect(settings.features.completion).toBe(true);
        expect(settings.suggest.componentSnippets).toBe(true);
        expect(settings.inlayHints.parameterTypes).toBe(true);
    });

    it('treats malformed sections as absent instead of throwing', () =>
    {
        const settings = parseSettings({ diagnostics: 'nope', hover: 42, inlayHints: null, format: [] });
        expect(settings.diagnostics.enable).toBe(true);
        expect(settings.features.hover).toBe(true);
        expect(settings.inlayHints.enabled).toBe(true);
        expect(settings.format.enable).toBe(true);
    });

    it('only the literal false disables - other falsy or stringly values stay on', () =>
    {
        const settings = parseSettings({ hover: { enable: 'false' }, diagnostics: { enable: 0 } });
        expect(settings.features.hover).toBe(true);
        expect(settings.diagnostics.enable).toBe(true);
    });
});
