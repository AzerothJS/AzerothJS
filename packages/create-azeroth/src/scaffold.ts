/**
 * MODULE: create-azeroth/scaffold - the copy engine
 *
 * Scaffolding is a recursive copy with two substitutions and one rename, nothing more:
 * `{{name}}` and `{{version}}` are replaced in every file (the version is this package's
 * own - the whole @azerothjs family versions in lockstep), and `_gitignore` becomes
 * `.gitignore` (npm strips real .gitignore files out of published packages, so templates
 * cannot carry one under its own name). Every template file is text by construction.
 * The target must not already contain files - scaffolding never overwrites anything.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TEMPLATES = ['frontend', 'backend', 'fullstack'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export function isTemplateName(value: string): value is TemplateName
{
    return (TEMPLATES as readonly string[]).includes(value);
}

/** True when the directory does not exist or exists empty - the only states scaffold accepts. */
export function isEmptyTarget(target: string): boolean
{
    if (!existsSync(target))
    {
        return true;
    }
    try
    {
        return readdirSync(target).length === 0;
    }
    catch
    {
        return false;
    }
}

function copyTree(from: string, to: string, substitute: (text: string) => string): void
{
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true }))
    {
        const source = join(from, entry.name);
        if (entry.isDirectory())
        {
            copyTree(source, join(to, entry.name), substitute);
            continue;
        }
        const target = join(to, entry.name === '_gitignore' ? '.gitignore' : entry.name);
        writeFileSync(target, substitute(readFileSync(source, 'utf8')));
    }
}

/**
 * Copies the named template into `target` with `{{name}}`/`{{version}}` substituted.
 * Throws when the target is not empty - the caller owns messaging and exit codes.
 */
export function scaffold(templatesRoot: string, template: TemplateName, target: string, name: string, version: string): void
{
    if (!isEmptyTarget(target))
    {
        throw new Error(`${ target } already exists and is not empty - scaffolding never overwrites`);
    }
    const substitute = (text: string): string => text.replaceAll('{{name}}', name).replaceAll('{{version}}', version);
    copyTree(join(templatesRoot, template), target, substitute);
}
