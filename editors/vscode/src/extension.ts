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

    // A manual restart for when the server wedges (vscode-languageclient already
    // auto-restarts on a crash and owns the "AzerothJS Language Server" output
    // channel for its logs and the `azeroth.trace.server` trace).
    context.subscriptions.push(vscode.commands.registerCommand('azeroth.restartServer', async () =>
    {
        await client?.restart();
    }));

    // Tag auto-closing: after the user types `>`, ask the server whether it
    // completes an opening tag, and if so insert `</tag>` with the caret left
    // between the pair. (VS Code has no built-in tag close for custom languages,
    // so we drive it ourselves.)
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
        // The handler can fire while the server is down or restarting, so bail
        // rather than assert a live client and risk an unhandled rejection.
        if (!client)
        {
            return;
        }
        const position = change.range.start.translate(0, 1);
        try
        {
            const snippet = await client.sendRequest<string | null>('azeroth/autoInsert', {
                textDocument: { uri: event.document.uri.toString() },
                position: { line: position.line, character: position.character }
            });
            // Re-check after the await: the caret may have moved while the
            // request was in flight, so an insert here would land stale.
            if (snippet && editor.selection.active.isEqual(position))
            {
                await editor.insertSnippet(new vscode.SnippetString(snippet), position);
            }
        }
        catch (error)
        {
            client.outputChannel.appendLine(`azeroth/autoInsert failed: ${ error }`);
        }
    }));
}

/** Called by VS Code on shutdown; stops the server cleanly. */
export function deactivate(): Thenable<void> | undefined
{
    return client?.stop();
}
