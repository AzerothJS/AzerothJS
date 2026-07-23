// Shared fixture builders: throwaway project trees under the OS temp dir. Each spec
// creates what it needs file by file - detection and planning read the real filesystem,
// so the tests exercise the real rules, not mocks of them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function makeRoot(): string
{
    return mkdtempSync(join(tmpdir(), 'azeroth-cli-'));
}

export function write(root: string, relPath: string, content: string): void
{
    const path = join(root, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}

export function cleanup(root: string): void
{
    rmSync(root, { recursive: true, force: true });
}

export function packageJson(deps: Record<string, string> = {}, extra: Record<string, unknown> = {}): string
{
    return JSON.stringify({ name: 'fixture', version: '0.0.0', dependencies: deps, ...extra });
}
