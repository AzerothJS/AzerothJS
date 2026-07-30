/**
 * MODULE: create-azeroth/scaffold - the copy engine
 *
 * Scaffolding is a recursive copy with two substitutions and a rename table, nothing
 * more: `{{name}}` and `{{version}}` are replaced in every file (the version is this
 * package's own - the whole @azerothjs family versions in lockstep), and a few files
 * travel under an underscore alias because their real names are live in this repo:
 * npm strips `.gitignore` out of published packages, and ESLint 10 resolves the
 * nearest `eslint.config.ts` per file, so a real one inside `templates/` would hijack
 * the monorepo's own lint runs. Template files are text except a short list of binary
 * asset extensions (favicons), which are copied byte-for-byte.
 * The target must not already contain files - scaffolding never overwrites anything.
 *
 * OPTIONS are overlays under `overlays/<template>/<option>/`, applied after the base
 * with exactly three operations - a file copy that MAY overwrite a base file, a
 * `_package.merge.json` that merges its top-level objects into the sibling
 * package.json, and a `_readme.append.md` appended to the sibling README.md. No
 * hooks, no codemods: an option that cannot be expressed in those three operations
 * redesigns the base until it can. When two options both refine the same file, a
 * combined overlay named `<a>-<b>` (alphabetical) applied LAST carries the merged
 * refinement.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** The shapes a scaffold can produce, in the order the prompt offers them. */
export const TEMPLATES = ['frontend', 'backend', 'fullstack'] as const;

/** One of the three template names - the CLI validates free-form input with {@link isTemplateName}. */
export type TemplateName = (typeof TEMPLATES)[number];

/** The overlay options each shape offers, in application order. */
export const TEMPLATE_OPTIONS: Record<TemplateName, readonly OptionName[]> =
{
    frontend: ['router', 'tailwind'],
    backend: [],
    fullstack: ['tailwind']
};

/** An overlay option name; validity is per-shape - see {@link TEMPLATE_OPTIONS}. */
export type OptionName = 'router' | 'tailwind';

/** Narrows user-typed input (a menu number is resolved before this) to a template name. */
export function isTemplateName(value: string): value is TemplateName
{
    return (TEMPLATES as readonly string[]).includes(value);
}

/**
 * npm's own package-name shape. The name also becomes the DIRECTORY, and a project name is
 * one path segment: `.`, `..`, `a/../b`, `/foo` and `//server/share` are all names a prompt
 * would happily accept and every one of them scaffolds somewhere the user never named. The
 * leading character class is what rejects `.` and `..`; the only `/` allowed opens a scope.
 */
const PROJECT_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * The directory a project name scaffolds into, or null when the name is not usable: the
 * shape is checked first, then the RESOLVED path is required to stay under `cwd` - on
 * Windows a leading separator is drive-relative, so `/name` lands at the drive root.
 */
export function resolveProjectTarget(cwd: string, name: string): string | null
{
    if (!PROJECT_NAME.test(name))
    {
        return null;
    }
    const root = resolve(cwd);
    const target = resolve(root, name);
    return target.startsWith(root.endsWith(sep) ? root : `${ root }${ sep }`) ? target : null;
}

/**
 * True when the directory does not exist or exists empty - the only states scaffold accepts.
 *
 * @internal Exposed for tests; scaffold applies this guard itself.
 */
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
    '_eslint.config.ts': 'eslint.config.ts'
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
        if (entry.name === '_package.merge.json')
        {
            mergePackageJson(join(to, 'package.json'), substitute(readFileSync(source, 'utf8')));
            continue;
        }
        if (entry.name === '_readme.append.md')
        {
            const readme = join(to, 'README.md');
            writeFileSync(readme, `${ readFileSync(readme, 'utf8').replace(/\n*$/, '\n\n') }${ substitute(readFileSync(source, 'utf8')) }`);
            continue;
        }
        const target = join(to, RENAMES[entry.name] ?? entry.name);
        // Binary assets (favicons, images) are copied byte-for-byte - a UTF-8 round
        // trip would corrupt them, and they carry no {{placeholders}} by definition.
        if (BINARY_EXTENSIONS.test(entry.name))
        {
            copyFileSync(source, target);
            continue;
        }
        writeFileSync(target, substitute(readFileSync(source, 'utf8')));
    }
}

const BINARY_EXTENSIONS = /\.(png|ico|jpe?g|gif|webp|avif|woff2?)$/i;

/** Merges the patch's top-level objects key-wise into the sibling package.json (scalars replace). */
function mergePackageJson(manifestPath: string, patchText: string): void
{
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const patch = JSON.parse(patchText) as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch))
    {
        const current = manifest[key];
        manifest[key] = typeof value === 'object' && value !== null && !Array.isArray(value)
            && typeof current === 'object' && current !== null && !Array.isArray(current)
            ? Object.fromEntries(Object.entries({ ...current, ...value }).sort(([a], [b]) => a.localeCompare(b)))
            : value;
    }
    writeFileSync(manifestPath, `${ JSON.stringify(manifest, null, 4) }\n`);
}

/**
 * The overlay directories a template + option selection applies, in order: each chosen
 * option's own overlay, then the combined `<a>-<b>` overlay when it exists on disk
 * (it carries the files both options refine, so it must win).
 */
function overlayDirs(overlaysRoot: string, template: TemplateName, options: readonly OptionName[]): string[]
{
    const chosen = TEMPLATE_OPTIONS[template].filter((option) => options.includes(option));
    const dirs = chosen.map((option) => join(overlaysRoot, template, option));
    if (chosen.length > 1)
    {
        const combined = join(overlaysRoot, template, chosen.join('-'));
        if (existsSync(combined))
        {
            dirs.push(combined);
        }
    }
    return dirs;
}

/**
 * Copies the named template tree into `target`, substituting `{{name}}` and `{{version}}`
 * in every file, then applies each chosen option's overlay (see the module banner).
 * Call it once the CLI has resolved a valid template, options, and destination.
 *
 * @param templatesRoot Directory holding the template folders, one per {@link TemplateName};
 *                      option overlays live in its sibling `overlays/` directory.
 * @param template Which template tree to copy.
 * @param target Destination directory; created if absent, and must be empty.
 * @param name Value written in place of `{{name}}` (the project/package name).
 * @param version Value written in place of `{{version}}` - a semver range, e.g. `^1.0.0`.
 * @param options Overlay options to apply; each must be valid for the shape per {@link TEMPLATE_OPTIONS}.
 * @throws Error when `target` already exists and is not empty, or an option does not
 *         belong to the template; the caller owns messaging and exit codes.
 */
export function scaffold(templatesRoot: string, template: TemplateName, target: string, name: string, version: string, options: readonly OptionName[] = []): void
{
    if (!isEmptyTarget(target))
    {
        throw new Error(`${ target } already exists and is not empty - scaffolding never overwrites`);
    }
    for (const option of options)
    {
        if (!TEMPLATE_OPTIONS[template].includes(option))
        {
            throw new Error(`--${ option } is not an option for the ${ template } template`);
        }
    }
    const substitute = (text: string): string => text.replaceAll('{{name}}', name).replaceAll('{{version}}', version);
    copyTree(join(templatesRoot, template), target, substitute);
    for (const overlay of overlayDirs(join(dirname(templatesRoot), 'overlays'), template, options))
    {
        copyTree(overlay, target, substitute);
    }
}
