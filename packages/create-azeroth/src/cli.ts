#!/usr/bin/env node
/**
 * MODULE: create-azeroth/cli - `npm create azeroth@latest`
 *
 * The day-one path, interrogation-free: at most two questions (a name if none was given,
 * a shape if --template was not passed), then a scaffold and three printed next steps.
 * Opinions live in the templates - eslint with the azeroth rules, the typecheck gate,
 * the azeroth CLI verbs - not in questions. Non-interactive runs (CI) must pass both
 * answers as arguments; prompting requires a TTY and fails loud without one.
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { TEMPLATES, isTemplateName, scaffold, type TemplateName } from './scaffold.ts';

// The scaffolder's user interface writes to stdout/stderr directly (stderr for errors,
// so stdout stays pipe-clean) - one place, not scattered console calls. The runtime
// logger (@azerothjs/logger) is telemetry for running apps; none of this is telemetry.
function print(line = ''): void
{
    process.stdout.write(`${ line }\n`);
}

function printError(line: string): void
{
    process.stderr.write(`${ line }\n`);
}

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

const TEMPLATE_DESCRIPTIONS: Record<TemplateName, string> =
{
    frontend: 'a vite app in .azeroth components',
    backend: 'an @azerothjs/http server, no build step',
    fullstack: 'application/ + server/, one dev command'
};

async function ask(question: string): Promise<string>
{
    if (!process.stdin.isTTY)
    {
        printError('create-azeroth: not a terminal - pass the answers as arguments: create-azeroth <name> --template <frontend|backend|fullstack>');
        process.exit(2);
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await readline.question(question);
    readline.close();
    return answer.trim();
}

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
        printError(`create-azeroth: ${ error instanceof Error ? error.message : String(error) }\n`);
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

    let name = parsed.positionals[0] ?? '';
    if (name === '')
    {
        name = await ask('Project name › ');
        if (name === '')
        {
            name = 'azeroth-app';
        }
    }
    if (!/^[a-z0-9@/_.-]+$/i.test(name))
    {
        printError(`create-azeroth: '${ name }' is not a usable directory/package name`);
        return 2;
    }

    let template = parsed.values.template ?? '';
    if (template === '')
    {
        print('What are you building?');
        for (const [index, candidate] of TEMPLATES.entries())
        {
            print(`  ${ index + 1 }. ${ candidate.padEnd(10) } ${ TEMPLATE_DESCRIPTIONS[candidate] }`);
        }
        const answer = await ask('› ');
        const byNumber = TEMPLATES[Number(answer) - 1];
        template = byNumber ?? answer;
    }
    if (!isTemplateName(template))
    {
        printError(`create-azeroth: unknown template '${ template }' - expected one of: ${ TEMPLATES.join(', ') }`);
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
        printError(`create-azeroth: ${ error instanceof Error ? error.message : String(error) }`);
        return 2;
    }

    print(`\nScaffolded ${ name } (${ template }${ template === 'fullstack' ? ': application/ + server/' : '' })`);
    print(`\n  cd ${ name }`);
    print('  npm install');
    print('  npm run dev\n');
    return 0;
}

process.exitCode = await main();
