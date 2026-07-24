#!/usr/bin/env node
/**
 * MODULE: create-azeroth/cli - `npm create azeroth@latest`
 *
 * The day-one path, interrogation-free: at most two questions (a name if none was
 * given, a shape if --template was not passed), asked in the framework's interaction
 * column (@azerothjs/logger's prompt primitives), then a scaffold
 * and an outro with the three next steps. Opinions live in the templates - eslint
 * with the azeroth rules, the typecheck gate, the azeroth CLI verbs - not in
 * questions.
 *
 * Non-interactive runs (CI) must pass both answers as arguments: the prompts refuse
 * a non-TTY by contract, so this file guards `isTTY` first and fails loud with the
 * args form. Piped output renders the intro/outro as plain text (the palette's
 * none tier) - a CI log stays clean.
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { colorTier, intro, outro, palette, select, textInput } from '@azerothjs/logger';

import { TEMPLATES, isTemplateName, scaffold, type TemplateName } from './scaffold.ts';

// The scaffolder's user interface writes to stdout/stderr directly (stderr for errors,
// so stdout stays pipe-clean). The runtime logger records are telemetry; none of this is.
function print(line = ''): void
{
    process.stdout.write(`${ line }\n`);
}

function fail(message: string): void
{
    const paint = palette(colorTier(process.stderr));
    process.stderr.write(`${ paint.red('x') } create-azeroth: ${ message }\n`);
}

const NON_TTY_HINT = 'not a terminal - pass the answers as arguments: create-azeroth <name> --template <frontend|backend|fullstack>';

const VERSION = ((): string =>
{
    try
    {
        return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    }
    catch
    {
        return '0.0.0';
    }
})();

const USAGE = `create-azeroth ${ VERSION }

Usage: npm create azeroth@latest [name] [-- --template <frontend|backend|fullstack>]

Scaffolds an AzerothJS app. With no arguments it asks two questions; with both
answers given it asks nothing (CI-safe).`;

const TEMPLATE_HINTS: Record<TemplateName, string> =
{
    frontend: 'a vite app in .azeroth components',
    backend: 'an @azerothjs/http server, no build step',
    fullstack: 'application/ + server/, one dev command'
};

async function main(): Promise<number>
{
    let parsed;
    try
    {
        parsed = parseArgs({
            args: process.argv.slice(2),
            options: {
                template: { type: 'string', short: 't' },
                help: { type: 'boolean', short: 'h', default: false },
                version: { type: 'boolean', short: 'v', default: false }
            },
            allowPositionals: true
        });
    }
    catch (error)
    {
        fail(error instanceof Error ? error.message : String(error));
        print(USAGE);
        return 2;
    }
    if (parsed.values.version)
    {
        print(VERSION);
        return 0;
    }
    if (parsed.values.help)
    {
        print(USAGE);
        return 0;
    }

    const interactive = parsed.positionals[0] === undefined || (parsed.values.template ?? '') === '';
    if (interactive)
    {
        if (!process.stdin.isTTY)
        {
            fail(NON_TTY_HINT);
            return 2;
        }
        intro('create-azeroth', `v${ VERSION }`);
    }

    let name = parsed.positionals[0] ?? '';
    if (name === '')
    {
        const answer = await textInput('Project name');
        if (answer === null)
        {
            return 2; // cancelled - the prompt already said so
        }
        name = answer === '' ? 'azeroth-app' : answer;
    }
    if (!/^[a-z0-9@/_.-]+$/i.test(name))
    {
        fail(`'${ name }' is not a usable directory/package name`);
        return 2;
    }

    let template = parsed.values.template ?? '';
    if (template === '')
    {
        const choice = await select(
            'What are you building?',
            TEMPLATES.map((value) => ({ value, hint: TEMPLATE_HINTS[value] }))
        );
        if (choice === null)
        {
            return 2; // cancelled - the prompt already said so
        }
        template = choice;
    }
    if (!isTemplateName(template))
    {
        fail(`unknown template '${ template }' - expected one of: ${ TEMPLATES.join(', ') }`);
        return 2;
    }

    const target = resolve(process.cwd(), name);
    const templatesRoot = fileURLToPath(new URL('../templates', import.meta.url));
    try
    {
        scaffold(templatesRoot, template, target, basename(target), `^${ VERSION }`);
    }
    catch (error)
    {
        fail(error instanceof Error ? error.message : String(error));
        return 2;
    }

    outro(
        `Scaffolded ${ name } (${ template }${ template === 'fullstack' ? ': application/ + server/' : '' })`,
        [`cd ${ name }`, 'npm install', 'npm run dev']
    );
    return 0;
}

process.exitCode = await main();
