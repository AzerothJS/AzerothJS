/**
 * MODULE: create-azeroth/scaffold - the copy engine
 *
 * Scaffolding is a recursive copy with two substitutions and a rename table, nothing
 * more: `{{name}}` and `{{version}}` are replaced in every file (the version is this
 * package's own - the whole @azerothjs family versions in lockstep), and a few files
 * travel under an underscore alias because their real names are live in this repo:
 * npm strips `.gitignore` out of published packages, and ESLint 10 resolves the
 * nearest `eslint.config.js` per file, so a real one inside `templates/` would hijack
 * the monorepo's own lint runs. Every template file is text by construction.
 * The target must not already contain files - scaffolding never overwrites anything.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The shapes a scaffold can produce, in the order the prompt offers them. */
export const TEMPLATES = ['frontend', 'backend', 'fullstack'] as const;

/** One of the three template names - the CLI validates free-form input with {@link isTemplateName}. */
export type TemplateName = (typeof TEMPLATES)[number];

/** Narrows user-typed input (a menu number is resolved before this) to a template name. */
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

// Files whose real names cannot exist inside templates/ (see the module banner).
const RENAMES: Record<string, string> =
{
    '_gitignore': '.gitignore',
    '_eslint.config.js': 'eslint.config.js'
};

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
        const target = join(to, RENAMES[entry.name] ?? entry.name);
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
