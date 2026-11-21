# Engineering handoff

## ENG-BOOTSTRAP — engineering infrastructure

- **Focus and status.** Bootstrap in progress on `main`. No product milestone or framework bug is assigned.
- **Baseline.** Started at `a9eb35c` with a clean index and working tree. The existing Claude knowledge store was ignored and untracked. Its two canonical documents, design files, scoped workflows, four linked worktrees and personal permissions predate this task.
- **Decision.** Keep the original knowledge paths. Use a single shared protocol and role specifications, with native provider adapters. Track only new engineering files. Importing pre-existing private documents would require separate authorization. Copying them into competing new documents would create divergence. This decision affects engineering configuration and has no framework API impact.
- **Acceptance.** Verify both native adapter formats, role discovery and boundaries, a harmless local Playwright MCP interaction per provider, Git path isolation and independent review. Record each provider's actual result and any remediation.
- **Progress and ownership.** Principal owns the protocol, entrypoints, adapters, commits and this handoff. Separate contributors own the architecture index, role specifications and MCP verification. Existing framework source, tests, manifests and product statuses are outside bootstrap scope.
- **Checks executed before edits.** `npm run typecheck` passed. `npm test -- packages/schema/tests/standard-schema.spec.ts` passed, 4/4. Build and full framework suite were not part of this baseline.
- **Blocker for fresh clones.** Neither `.claude/ROADMAP.md` nor `.claude/framework-bugs.md` has a Git revision. Both originals are available here and appear as untracked files under the new ignore rules. Keep them out of bootstrap commits. Restore the originals from the maintainer or arrange a separately reviewed import before relying on a fresh clone for product work.
- **Commits and next action.** See the current task commits via `git log a9eb35c..HEAD --oneline`. Validate provider registration and interaction, review the final diffs, and record the results here.
