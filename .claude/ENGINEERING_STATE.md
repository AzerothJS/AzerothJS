# Engineering handoff

## Current framework handoff, 2026-11-21

**A-324, A-325 and A-326 complete.** The principal engineer integrated the shared cache and mutation changes. A separate test owner covered direct readers, router rollback and observer settlement. The [decision and compatibility record](decisions/optimistic-cache-reads.md) covers cold and unreadable cache values, one-shot cancellation, seed adoption, error delivery and the refutation findings. The original tracker has no consumer ticket for these three roadmap discoveries. The commit is available with `git log -1 -- .claude/decisions/optimistic-cache-reads.md`.

The approved GPT-6 Astra Codex agents traced the current source, challenged the design and reviewed the actual changes. The final independent code reviewer approved the synchronous abort/seed correction. With Node 24.22.3 and npm 11.18.0, `npm run verify` passed in an isolated local checkout with the exact candidate files. All 430 test files passed with 7,181 tests passing and two skipped. The baseline was 428 files, 7,161 passing and two skipped. `npm run smoke` passed for all 15 packages, six executable targets and 621 shipped files. Earlier release-guard timeouts in the main working checkout did not recur in the isolated full gate.

The registered Playwright QA role used isolated Chromium against a compiled, SSR-rendered and hydrated app built from local npm archives. On the original runtime, two cart clicks sent zero writes and showed 7 against a server count of 5. On the final runtime both writes succeeded, the resource stayed loading while the reads were held, and the UI and server agreed at 7 after revalidation. A fetched projection that refused its input still delivered the server receipt and settled at 6. Both final pages retained the server root. The full gate includes relevant runtime and tooling checks. The browser run covered Chromium on Windows.

**Next action.** Begin unit 6, A-206 with A-207. Read tracker entry 38 and `.claude/FETCHER-TRACKING.md`, reproduce the unwanted pre-await signal subscriptions in the resource fetch and mutation write, and refute the untracking boundaries before editing. A-327 retains its independent seed-versus-mark question. Clients that relied on optimistic one-shot reads need the migration recorded for release planning. The local canonical files remain outside Git.

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
