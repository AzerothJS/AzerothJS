// Lint findings surface as editor diagnostics: warning severity, the
// 'azeroth-lint' source, accurate ranges - and they never suppress (or get
// suppressed by) the TypeScript diagnostics they sit alongside.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

let ls: AzerothLanguageService;

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
});

describe('lint diagnostics', () =>
{
    it('reports a handler-call warning with the lint source', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'LintHandler.azeroth'));
        const src = [
            'const save = (): void => undefined;',
            'const x = <button onClick={save()}>go</button>;'
        ].join('\n');
        ls.didOpen(uri, src);

        const diags = ls.getDiagnostics(uri);
        const lint = diags.find(d => d.source === 'azeroth-lint');

        expect(lint).toBeTruthy();
        expect(lint!.code).toBe('azeroth/handler-call');
        expect(lint!.severity).toBe(2); // Warning
    });

    it('reports lint warnings WITHOUT suppressing type errors', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'LintAndType.azeroth'));
        const src = [
            'const save = (): void => undefined;',
            'const n: number = "not a number";',
            'const x = <button onclick={save}>go</button>;'
        ].join('\n');
        ls.didOpen(uri, src);

        const diags = ls.getDiagnostics(uri);

        expect(diags.some(d => d.source === 'azeroth-lint' && d.code === 'azeroth/event-case')).toBe(true);
        expect(diags.some(d => d.source === 'azeroth-ts' && d.severity === 1)).toBe(true);
    });

    it('a hard parse error still suppresses everything else', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'LintBroken.azeroth'));
        ls.didOpen(uri, 'const x = <a onclick={f}></b>;');

        const diags = ls.getDiagnostics(uri);

        expect(diags).toHaveLength(1);
        expect(diags[0].source).toBe('azeroth');
        expect(diags[0].severity).toBe(1); // Error
    });

    it('clean markup produces no lint diagnostics', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'LintClean.azeroth'));
        const src = [
            'const save = (): void => undefined;',
            'const x = <button onClick={save}>go</button>;'
        ].join('\n');
        ls.didOpen(uri, src);

        expect(ls.getDiagnostics(uri).filter(d => d.source === 'azeroth-lint')).toHaveLength(0);
    });
});
