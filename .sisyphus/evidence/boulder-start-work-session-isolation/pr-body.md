## Summary

- Restricts no-arg `/start-work` resume to work already bound to the current session, so an unbound session must explicitly select an active/paused plan instead of auto-resuming unrelated work.
- Applies the same session-scoped rule to CLI `command.execute.before` continuation injection, preventing `opencode run --command start-work` from continuing the first active work for an unbound session.
- Updates the built-in `/start-work` template to document the session-scoped resume contract.

## Evidence

- Negative before-fix repro: `.sisyphus/evidence/boulder-start-work-session-isolation/task-2-negative-repro-before-fix.txt`
- Positive after-fix real CLI rerun: `.sisyphus/evidence/boulder-start-work-session-isolation/task-7-positive-rerun-after-fix.txt`
- Explicit-plan after-fix evidence: `.sisyphus/evidence/boulder-start-work-session-isolation/task-7-explicit-plan-b-after-fix.txt`
- Task 8 verification evidence: `.sisyphus/evidence/boulder-start-work-session-isolation/task-8-full-verification.txt`

## Verification

- `bun test src/hooks/start-work/context-info-builder.test.ts` -> passed.
- `bun test src/hooks/start-work/index.test.ts` -> passed.
- `bun test src/plugin/command-execute-before.test.ts` -> passed.
- `bun run typecheck` -> passed.
- `bun run build` -> passed.
- `lsp_diagnostics` was attempted for `src/hooks/start-work` and is blocked locally because `typescript-language-server` is not installed.
- Full `bun test` evidence is captured in `task-8-full-verification.txt`; the run currently exposes unrelated pre-existing/environment-sensitive failures outside this change scope, while the targeted start-work regression tests pass.

## Safety

- No temp OpenCode DB/config/data or secrets are committed.
- No user-level config, `node_modules`, `dist`, package version bumps, or publish artifacts are committed.
- Temporary dependency/evidence symlinks used for verification were removed before final status.
