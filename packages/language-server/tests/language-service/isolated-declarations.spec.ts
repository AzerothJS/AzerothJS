// @vitest-environment node
//
// Regression: a real tsconfig with `isolatedDeclarations: true` must not leak into the `.azeroth`
// projection. The projection lowers each `export`ed component to an inference-typed function with no
// written return type (the compiler owns the render return), so under isolatedDeclarations TypeScript
// reports 9007 ("Function must have an explicit return type annotation") on the component's name - a
// diagnostic the author can neither act on nor should. The host runs with `noEmit`, so the
// declaration-emit constraint is moot there; it is overridden off for the virtual program. This pins
// that the override holds AND that ordinary diagnostics still flow under the same config.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../../src/language-service/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const isolatedTsconfig = path.join(fixtures, 'tsconfig.isolated.json');

function open(name: string, source: string)
{
    const service = new AzerothLanguageService(fixtures, isolatedTsconfig);
    const uri = pathToFileURL(path.join(fixtures, name)).href;
    service.didOpen(uri, source);
    return { service, uri };
}

describe('isolatedDeclarations does not leak into the .azeroth projection', () =>
{
    it('an exported component produces no 9007 under isolatedDeclarations: true', { timeout: 30000 }, () =>
    {
        const src = 'export default component SignIn(props: { onGo: () => void })\n'
            + '{\n    state email = \'\';\n    <button onClick={ props.onGo }>{ email }</button>\n}\n';
        const { service, uri } = open('IsoOk.azeroth', src);
        const nine007 = service.getDiagnostics(uri).filter(d => d.code === 9007);
        expect(nine007).toEqual([]);
    });

    it('still reports genuine authoring diagnostics under the same config (not globally silenced)', { timeout: 30000 }, () =>
    {
        const src = 'export default component A\n{\n    state c = 0 with { notAnOption: 1 };\n    <p>{ c }</p>\n}\n';
        const { service, uri } = open('IsoLive.azeroth', src);
        const unknown = service.getDiagnostics(uri).find(d => d.code === 'azeroth/unknown-option');
        expect(unknown?.message).toContain('notAnOption');
    });

    it('still reports genuine TypeScript type errors under the same config (only the 9xxx family is off)', { timeout: 30000 }, () =>
    {
        // A non-function event handler is TS 1360, surfaced as a handler error. Disabling
        // isolatedDeclarations must not touch it: isolatedDeclarations only ADDS the 9006-9037
        // family, never removes a type-safety diagnostic.
        const src = 'export default component A\n{\n    <button onClick={ 5 }>x</button>\n}\n';
        const { service, uri } = open('IsoType.azeroth', src);
        const handler = service.getDiagnostics(uri).find(d => d.code === 1360);
        expect(handler?.message).toContain('Event handler must be a function');
    });
});
