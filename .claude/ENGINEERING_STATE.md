# Engineering handoff

## Current framework handoff, 2026-11-21

**A-208 complete.** A background async form check now follows the field value. A signal read by the synchronous rule or by an initial-value getter cannot postpone the debounce, abort the active check or start another one. The next field edit consults the current rule and initial value. The [decision and acceptance record](decisions/fetcher-tracking.md#a-208-follow-up-decision-2026-11-21) explains why both reads need the same boundary. Find the implementation commit with `git log -1 -- packages/azerothjs/src/form/create-form.ts`.

The principal integrated the runtime and docs. The test owner added five cases. The registered architecture refuter challenged the rule-only fix with an accessor-backed initial value, and the independent code reviewer approved the final implementation. The registered Playwright QA role observed three requests and two cancellations for an unchanged handle on the original runtime. The corrected packed form kept one request and zero cancellations. Editing the field during a later request superseded that request. Both the direct-read and explicit-untrack forms passed in Chromium, Firefox and WebKit on Windows.

On Node 24.22.3 and npm 11.18.0, all 69 form tests passed. Three CLI release-guard tests timed out on the first full run. All 19 release-guard tests passed separately, then the unchanged `npm run verify` passed across all 433 files with 7,212 tests passing and two skipped. Package smoke passed for all 15 workspaces, six executable targets and 623 shipped files. Explicit submission, reset and dirty-state reporting keep their independent semantics.

**Next action.** Begin the joint unit 7 design for A-162, A-198, A-209, A-312 and A-317. Start from tracker entries 35 and 48. Reproduce an unchanged source key aborting an in-flight resource request, and measure when an overlapping `refetch()` promise settles. Use those observations to specify key equality, stream cancellation, loading and refetch settlement together before editing the shared effect. The canonical roadmap and tracker remain local.

**Previous work.** `72cd2ab` closed A-206 and A-207 and resolved tracker entry 38. `54c148e` closed A-324, A-325 and A-326. Their [fetcher tracking](decisions/fetcher-tracking.md) and [optimistic cache](decisions/optimistic-cache-reads.md) records retain the migrations and verification. A-327 retains its separate seed-versus-mark question.

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
