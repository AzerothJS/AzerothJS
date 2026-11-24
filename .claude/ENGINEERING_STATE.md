# Engineering handoff

## Current framework handoff, 2026-11-24

**Unit 16, A-145 complete.** Compiled bare HTML table rows now keep reactive cell and event bindings on their intended nodes. Known row and column groups use one render plan. Mixed table clones keep insertion points for unknown rows or sections on the table, preserving native template contents and form reset defaults. Server rendering and hydration retain their historical placement for mixed children. Use an explicit tbody for selectors that depend on a projected row's parent. Compiler/runtime contract 7 applies. [Compiling bare table rows](decisions/table-row-rendering.md).

**Verification.** Full repository verification passed 8,178 tests in 465 files, with two skipped. All 15 packages passed consumer smoke. Twelve compiler cases and twelve permanent Chromium scenarios pass. The packed application passed 240 development and production checks across Chromium, Firefox and WebKit. All 168 interactive inventory runs retained the draft and original nodes. Nine registered MCP workflows passed with 148 HTTP 200 responses. The separate native-template hydration failure across six receipt loads is tracked under A-341, consumer entry 57. A-141 tracks other mixed-table hydration behavior.

**Next action.** Continue unit 16 with A-158 and A-176 together. Compile the reported multi-line division following a TypeScript non-null assertion, then exercise a following keyword block with its opening brace on the same line and on the next line. Compare the compiler, Vite and editor diagnostics against division and regular-expression controls. A-169 follows this tokenizer work. Find the A-145 commit with `git log -1 -- .claude/decisions/table-row-rendering.md`.

**Previous work.** `9305d00` fixed [HTML and foreign text handling](decisions/namespace-text.md). `9e15126` fixed [row shorthand and prop default scope](decisions/prop-defaults-and-row-shorthand.md). `f697a37` fixed [lexical names in reactive expressions](decisions/reactive-name-resolution.md). `5db831b` fixed [locale prerendering and serving](decisions/locale-prerender.md). `f866b51` fixed [static text adoption and hydration fallback reporting](decisions/static-text-hydration.md). `dcfee32` fixed [conditional branch selection](decisions/branch-selection.md). `3d0846a` fixed [branch value lifetime](decisions/branch-value-lifetime.md). `86229c0` fixed [Show condition ownership](decisions/show-condition-ownership.md). `ca464f8` fixed [streamed seed ownership and Suspense watch lists](decisions/stream-seed-ownership.md). `b87d15f` fixed [component and error boundary construction](decisions/component-construction.md). `04fc843` fixed [lexical bindings in render callbacks](decisions/compiler-arrow-bindings.md). `b945b60` completed [rendered route ownership](decisions/rendered-route-ownership.md) after unit 8 (`758a3a4`). The original roadmap and tracker remain local to this checkout.

## Bootstrap history

**ENG-BOOTSTRAP, 2026-11-21.** Shared configuration and native transport verification were committed on `main`. Two maintainer actions were recorded for full portability and normal Claude use.

## Decision and delivered files

Keep the existing roadmap, bug tracker and design records at their original paths. Both providers use [one engineering protocol](ENGINEERING_PROTOCOL.md), [one architecture index](ARCHITECTURE_INDEX.md) and [ten role specifications](agent-specs/). The security reviewer inspects defensive controls and uses inert fixtures. Product statuses and framework behavior were outside this bootstrap.

| Local commit | Contents |
| --- | --- |
| `714fbe8` | Shared protocol, handoff, index, ten role specs and selective Git ignore rules. |
| `70ced1e` | Root `AGENTS.md` and `CLAUDE.md`, ten Claude Markdown adapters and ten Codex TOML adapters. |
| `5d43289` | Project MCP settings for both providers, Claude tool restrictions and the [reproducible browser check](PLAYWRIGHT_MCP.md). |

This handoff's own revision is available with `git log -1 -- .claude/ENGINEERING_STATE.md`. Run `git diff --name-status a9eb35c..5d43289` for the exact set of added and changed paths.

## Verification and limits

- **Baseline.** Clean index and working tree at `a9eb35c`. The 2.1.1 monorepo had 15 workspaces, 44 tracked Markdown files, and 428 specs under the Vitest discovery pattern plus five scaffold specs. The [index](ARCHITECTURE_INDEX.md) maps public contracts, source/test boundaries, and the 70 pre-existing Claude Markdown files. Existing browser logs were local artifacts. There was no tracked Playwright Test runner or configuration.
- **Native checks.** On Windows with Node 25.9.0 and npm 11.12.1, `npm run typecheck` passed before and after configuration. `npm test -- packages/schema/tests/standard-schema.spec.ts` passed 4/4 both times. The full framework build, lint, Vitest suite and package smoke were not executed for these documentation and agent configuration changes.
- **Role discovery.** Claude Code 2.1.322 SDK initialization returned all ten project roles after the final YAML change. Codex CLI 0.153.4 exposed all ten names and descriptions in its native spawn-tool schema captured locally. This checked registration without model-driven runs of the ten specialists. Structural checks parsed both formats, resolved references, compared the two adapters for each role, and verified read/write scopes and MCP configuration parity.
- **Browser.** Both native clients navigated, inspected, clicked and verified a new heading through the pinned Playwright MCP. A repeat with the documented two-page fixture returned four HTTP 200s across the two sessions, with zero console messages. Only isolated Chrome on Windows was exercised. The [evidence and commands](PLAYWRIGHT_MCP.md) distinguish direct client transport from a normal authenticated chat.
- **Git and review.** Independent review covered the actual protocol, index, roles, adapters, permissions, browser runbook and Git isolation. The committed engineering tree contains 40 paths including `.gitignore`. The two original canonical files matched their pre-edit SHA-256 values and were excluded from all bootstrap commits. Git visibility checks leave personal permissions, legacy worktrees and browser output ignored.

## Resume

1. **In this checkout:** Read the current framework handoff above, the protocol and canonical records from the repository root. Use the named next action and the project’s registered roles.
2. **For Claude's normal workflow:** Run `claude auth login`, start `claude` in this checkout and approve the project server named `playwright`. Verify it in `/mcp` and repeat the documented fixture. The native explicit-config path passed. Default project approval and the expired OAuth login still require the maintainer.
3. **For another clone:** The original `.claude/ROADMAP.md` and `.claude/framework-bugs.md` are untracked here. A Git archive of the bootstrap excludes both. Restore them from the maintainer, together with the roadmap skill and any referenced design dossiers or scoped workflows needed for the task. To make these available through Git, the maintainer must authorize a separate reviewed import of pre-existing knowledge. Keep the original names and review exact files before staging. Personal settings, browser output and nested worktrees stay private.
