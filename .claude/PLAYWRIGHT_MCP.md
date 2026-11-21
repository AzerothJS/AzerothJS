# Playwright MCP in AzerothJS

Codex reads [the project TOML](../.codex/config.toml) in a trusted checkout. Claude Code discovers [the project MCP file](../.mcp.json) and applies [project permissions](settings.json). Both start the same pinned npm package over stdio with `npx`. Use the name `playwright` when inspecting the connection, especially when a personal plugin also supplies browser tools.

The launcher needs Node/npm, a reachable npm registry or cached package, and Chrome available to Playwright. It starts a headless, sandboxed browser in an isolated context. The project requests HTTP loopback origins, disables webpage-provided MCP tools, and withholds arbitrary browser evaluation and code execution from this integration. Origin filtering and role instructions do not provide network isolation. Use only authorized local fixtures.

## Repeat the connection check

1. In a temporary directory outside the repository, create two UTF-8 files. Put `<!doctype html><html lang="en"><title>Local MCP smoke</title><h1>Local MCP smoke</h1><form action="/done.html"><button>Confirm fixture</button></form></html>` in `index.html`. Put `<!doctype html><html lang="en"><title>Fixture complete</title><h1>Confirmed local interaction</h1></html>` in `done.html`.
2. In that directory run `python -m http.server 8765 --bind 127.0.0.1`. In another terminal, change to the AzerothJS root. For Codex, inspect `codex mcp get playwright --json`, launch `codex` and confirm the project server in `/mcp`. For Claude, run `claude mcp get playwright`, open `claude`, and approve this project's server if prompted. Recheck it in `/mcp`. Renew an expired Claude login with `claude auth login`. Restart the session to pick up project configuration or agent changes.
3. Assign `playwright-qa` to open `http://127.0.0.1:8765/` with the project MCP. Require `browser_navigate`, `browser_snapshot`, a `browser_click` on **Confirm fixture** using the observed element reference, and a new snapshot. The first heading is **Local MCP smoke**. The form submission must land on `/done.html` with heading **Confirmed local interaction**.
4. Inspect `browser_console_messages` and `browser_network_requests` with `all: true` to include earlier page loads. Include document/static requests with `static: true` on the network call. Record observed status, any console/page errors, unexpected requests and exact browser. Close the context with `browser_close` and stop the fixture with Ctrl+C. The server's own terminal also records the response codes.

This check verifies provider wiring and one browser interaction. For framework changes use the actual compiled application, routes and acceptance criteria in the [engineering protocol](ENGINEERING_PROTOCOL.md).

## Bootstrap evidence (Windows, 2026-11-21)

| Client | Connection and actual interaction | Remaining condition |
| --- | --- | --- |
| Codex CLI 0.153.4 | Project discovery succeeded. The native app server listed 23 tools and called the project server. At `http://127.0.0.1:5702/`, the accessibility tree showed **Local MCP smoke** and **Confirm fixture**. Clicking the observed button submitted a GET to `/ack?`. The second snapshot showed **Confirmed local interaction**. Both requests returned 200, the console reported zero messages, and the context closed. | The running desktop chat did not expose this new MCP server. The verified client was the CLI app server. Open a fresh trusted project session to discover it. |
| Claude Code 2.1.322 | The native CLI loaded the final `.mcp.json` explicitly with `--strict-mcp-config --mcp-config .mcp.json`. Its SDK transport checked permissions on all seven MCP calls. At `http://127.0.0.1:2208/`, navigation, snapshot, button click, second snapshot, console, network and close produced the same observed headings, two HTTP 200s and zero console messages. | Default project discovery reported **Pending approval**. The model-driven run stopped at expired OAuth. Renew login, approve the named project server and repeat the fixture in a normal session. |

Both clients then repeated the two-file procedure above on port 8765 using isolated Chrome 157.0.8103.79 and `@playwright/mcp@0.0.86`. Each clicked the fixture button, reached `/done.html?`, observed the confirmation heading and closed its context. Python logged four GETs across the two runs, all HTTP 200. Both browser consoles reported zero messages. Framework functionality and other operating systems were outside this single-engine transport check.

When changing the package pin, compare command, arguments and environment in both files, verify the provider tool restrictions and run the smoke check in each client. Provider format references are the [Codex MCP guide](https://developers.openai.com/codex/mcp/), [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) and [Microsoft Playwright MCP options](https://github.com/microsoft/playwright-mcp).
