// Minimal file-URI <-> path conversion. The language server speaks `file://`
// URIs; the TypeScript host and the compiler speak OS paths. Keeping this tiny
// and dependency-free avoids pulling `vscode-uri` into the core.

/**
 * Converts a `file://` URI to an OS path. Non-file URIs and bare paths are
 * returned unchanged, so tests can pass plain paths.
 *
 * @example
 * ```ts
 * uriToPath('file:///c%3A/app/App.azeroth'); // 'c:/app/App.azeroth' (Windows)
 * uriToPath('/abs/App.azeroth');             // '/abs/App.azeroth'
 * ```
 */
export function uriToPath(uri: string): string
{
    if (!uri.startsWith('file://'))
    {
        return uri;
    }
    let path = decodeURIComponent(uri.slice('file://'.length));
    // Windows: `file:///c:/x` -> `/c:/x`; drop the leading slash before a drive.
    if (/^\/[a-zA-Z]:/.test(path))
    {
        path = path.slice(1);
    }
    return path;
}

/**
 * Converts an OS path to a `file://` URI.
 *
 * @example
 * ```ts
 * pathToUri('c:/app/App.azeroth'); // 'file:///c%3A/app/App.azeroth'
 * ```
 */
export function pathToUri(path: string): string
{
    if (path.startsWith('file://'))
    {
        return path;
    }
    const normalized = path.replace(/\\/g, '/');
    const withSlash = /^[a-zA-Z]:/.test(normalized) ? `/${ normalized }` : normalized;
    return `file://${ withSlash.split('/').map((seg, i) => i === 0 ? seg : encodeURIComponent(seg)).join('/') }`;
}
