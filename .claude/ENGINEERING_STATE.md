# Engineering handoff

## Current framework handoff, 2026-11-24

**A-121 and A-211 complete.** A compiled plain Show and a Switch keep the current editor mounted on a same-selection refresh. A real flip replaces it. Show, Switch and Dynamic remove outgoing content when cleanup throws and preserve the initiating error. Rebuild precompiled components with the matched v6 compiler and runtime. Find this commit with `git log -1 -- .claude/decisions/branch-selection.md`. The [branch selection decision](decisions/branch-selection.md) records the compatibility and error-handling contracts.

**Verification.** At `3d0846a`, 50 of 67 new selection tests and all six teardown regressions failed. The other 17 selection tests passed as controls. The final source passed 535 focused tests and caught 29 selection and nine teardown variants. Across Chromium, Firefox and WebKit each packed build exercised 36 editor and 18 archive scenarios. Native Playwright independently confirmed draft, focus, caret and shortcut retention, and exactly one ticket after a throwing close and reopen. All 15 packages passed smoke. The full gate passed 7,759 tests in 453 files with two skipped.

**Next action.** Start unit 12 with A-216. Type into an SSR form before startup and check whether hydrating adjacent static text and a constant expression replaces the form. Compare with a lone constant that should adopt. Address the remaining A-118 work on mismatch location and production reporting of a fallback. A-336 separately tracks throwing cleanup in For, Portal, TransitionGroup and nonanimated Routes. No follow-up work is active.

**Previous work.** `3d0846a` fixed [branch value lifetime](decisions/branch-value-lifetime.md). `86229c0` fixed [Show condition ownership](decisions/show-condition-ownership.md). `ca464f8` fixed [streamed seed ownership and Suspense watch lists](decisions/stream-seed-ownership.md). `b87d15f` fixed [component and error boundary construction](decisions/component-construction.md). `04fc843` fixed [lexical bindings in render callbacks](decisions/compiler-arrow-bindings.md). `b945b60` completed [rendered route ownership](decisions/rendered-route-ownership.md) after unit 8 (`758a3a4`). The original roadmap and tracker remain local to this checkout.

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
