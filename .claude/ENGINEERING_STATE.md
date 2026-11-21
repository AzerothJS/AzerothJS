# Engineering handoff

## Current framework handoff, 2026-11-21

**Rendered route ownership complete.** A-315, A-316, A-311 and A-335 close together, including tracker entries 47 and 51. A routed component keeps its params and loader outcome during a cold hold or leave. A departing layout keeps its nested outlet. A retained layout can observe `useRenderedMatch()` to retry a failed outlet when the next route is ready. The [implementation and verification](decisions/rendered-route-ownership.md) follow the [audit on the previous runtime](decisions/rendered-route-audit.md). Use `git log -1 -- .claude/decisions/rendered-route-ownership.md` for the implementation commit.

**Verification.** The baseline failed 30 of the 35 new cases. The fix passed all 35 and the suite detected all 18 independently introduced regressions. The full repository gate passed 7,393 tests with two skipped across 439 files. Package smoke passed for all 15 packages. A packed public app passed seven workflows each in Chromium, Firefox and WebKit. The registered Playwright agent separately verified the cold read, outlet-boundary reset and named transition. The decision records the original WebSocket timeout and successful full rerun.

**Next action.** Start compiler unit 9, A-213, A-214 and A-287. Reproduce the frozen arrow child with a changing public input, then distinguish lexical alias shadowing and collection-prefix binding in compiled output. Pin the three cases before modifying lowering. Unit 9 precedes units 10 and 11.

**Previous work.** Unit 8 (`758a3a4`) closed A-163, A-304, A-178, A-180, A-177 and A-179, tracker entry 29. See the [guard and hydration decision](decisions/router-boot.md). `8196b48` completed unit 7, `18c3238` closed A-208, `72cd2ab` closed A-206 and A-207, and `54c148e` closed A-324 through A-326. A-288 and A-334 remain separate follow-ups. The original roadmap and tracker remain local to this checkout.

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
