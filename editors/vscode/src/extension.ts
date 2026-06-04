// VS Code extension entry point. It does one job: launch the AzerothJS language
// server (@azerothjs/language-server) and connect a Language Server Protocol
// client to it for `.azeroth` documents. Every feature - completion, hover,
// diagnostics, definitions, rename, semantic tokens, … - is served by that
// process, so the extension itself stays a thin launcher.

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import {
    LanguageClient,
    TransportKind,
    type LanguageClientOptions,
    type ServerOptions
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/** Called by VS Code when the first `.azeroth` file opens. */
export function activate(context: ExtensionContext): void
{
    // Prefer the bundled server shipped beside this file (packaged .vsix);
    // fall back to the workspace dependency when running unbundled (F5 dev host).
    const bundledServer = path.join(__dirname, 'server.js');
    const serverModule = fs.existsSync(bundledServer)
        ? bundledServer
        : require.resolve('@azerothjs/language-server/cli');

    const serverOptions: ServerOptions =
    {
        run: { module: serverModule, transport: TransportKind.stdio },
        debug:
        {
            module: serverModule,
            transport: TransportKind.stdio,
            options: { execArgv: ['--nolazy', '--inspect=6009'] }
        }
    };

    const clientOptions: LanguageClientOptions =
    {
        documentSelector: [{ scheme: 'file', language: 'azeroth' }],
        synchronize:
        {
            // Re-evaluate when the project's TypeScript config changes.
            configurationSection: 'azeroth'
        }
    };

    client = new LanguageClient('azeroth', 'AzerothJS Language Server', serverOptions, clientOptions);
    client.start();

    // JSX-style tag auto-closing: after the user types `>`, ask the server
    // whether it completes an opening tag, and if so insert `</tag>` with the
    // caret left between the pair. (VS Code has no built-in tag close for
    // custom languages, so we drive it ourselves.)
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (event) =>
    {
        if (event.document.languageId !== 'azeroth' || event.contentChanges.length !== 1)
        {
            return;
        }
        const change = event.contentChanges[0];
        if (change.text !== '>' || change.rangeLength !== 0)
        {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document)
        {
            return;
        }
        const position = change.range.start.translate(0, 1);
        const snippet = await client!.sendRequest<string | null>('azeroth/autoInsert', {
            textDocument: { uri: event.document.uri.toString() },
            position: { line: position.line, character: position.character }
        });
        if (snippet && editor.selection.active.isEqual(position))
        {
            await editor.insertSnippet(new vscode.SnippetString(snippet), position);
        }
    }));
}

/** Called by VS Code on shutdown; stops the server cleanly. */
export function deactivate(): Thenable<void> | undefined
{
    return client?.stop();
}
