# Codex Harness Review Checklist

Use this checklist before merging any remaining harness work from
[2026-03-10-codex-harness-design.md](/home/nadeemm/athena/cli/docs/plans/2026-03-10-codex-harness-design.md).

## 1. Adapter Boundary

- [ ] App code resolves harness behavior through [src/harnesses/registry.ts](/home/nadeemm/athena/cli/src/harnesses/registry.ts), not harness-specific `switch` statements.
- [ ] New harness-specific behavior is added in an adapter file, not directly inside app code.
- [ ] `createRuntime()` remains a thin adapter lookup in [src/app/runtime/createRuntime.ts](/home/nadeemm/athena/cli/src/app/runtime/createRuntime.ts).
- [ ] Exec mode uses `createSessionController()` and interactive shell uses `useSessionController()`.
- [ ] No app-level cast to `CodexRuntime` or any other harness-specific runtime type exists outside harness internals.

## 2. Runtime vs Session Separation

- [ ] Runtime code only manages transport, event delivery, decision routing, and startup/error state.
- [ ] Session code owns turn execution, interruption, and harness-specific turn lifecycle.
- [ ] Claude runtime does not start Claude turns directly.
- [ ] Codex runtime does not expose app-only behavior that bypasses the session controller in app code.
- [ ] No new "process profile" abstraction is introduced.

## 3. Naming and Folder Hygiene

- [ ] Remaining Claude execution code is migrated from `claude/process/` to `claude/session/` when touched.
- [ ] No new files are added under a legacy `process/` folder unless they represent a real OS process concern.
- [ ] Codex shell state code lives under `codex/session/`, not `codex/process/`.
- [ ] Folder names reflect the architecture: `runtime`, `session`, `config`, `protocol`, `system`.

## 4. Codex Protocol Fidelity

- [ ] Codex protocol changes are validated against generated app-server schema or bindings, not memory.
- [ ] Hand-maintained method names are not extended casually if generated protocol data is available.
- [ ] Approval request handling covers the currently supported server request shapes explicitly.
- [ ] Unsupported Codex request types fail clearly and safely instead of being silently ignored.
- [ ] Thread and turn state handling matches the protocol sequence:
  - [ ] `initialize`
  - [ ] `initialized`
  - [ ] `thread/start` or `thread/resume`
  - [ ] `turn/start`
  - [ ] notifications and server requests during the turn
  - [ ] `turn/interrupt` when needed

## 5. Runtime Event Model

- [ ] Codex runtime does not encode provider-native lifecycle events as fake Claude hook events when a first-class runtime kind is warranted.
- [ ] If `turn/completed` is emitted by Codex, review whether it should map to `turn.complete` instead of `stop.request`.
- [ ] Token updates are modeled structurally if the app depends on them, instead of hiding them as generic notifications.
- [ ] Message deltas, plan deltas, and reasoning deltas are represented intentionally, not dropped by default.
- [ ] Raw provider payloads remain attached for diagnostics.

## 6. Feed Mapping and UI Semantics

- [ ] Changes to runtime event kinds are matched by corresponding feed-mapper updates in [src/core/feed/mapper.ts](/home/nadeemm/athena/cli/src/core/feed/mapper.ts).
- [ ] Feed mapping still preserves final assistant message extraction for exec mode.
- [ ] Session/run boundaries are still coherent for both Claude and Codex.
- [ ] Tool attribution remains correct for tool start, success, and failure events.
- [ ] Token metrics shown in the header remain valid after event model changes.

## 7. Claude Stability

- [ ] Claude still runs through official headless mode with `claude -p`.
- [ ] Claude still uses settings-configured hooks via Athena's hook-forwarder path.
- [ ] Claude isolation behavior is unchanged unless a deliberate migration is being reviewed.
- [ ] Claude session restore/resume behavior still works.
- [ ] Claude token parsing still works for `--output-format stream-json`.

## 8. Exec Mode

- [ ] `runExec()` in [src/app/exec/runner.ts](/home/nadeemm/athena/cli/src/app/exec/runner.ts) remains harness-agnostic.
- [ ] Exec loop behavior remains correct for workflow loops and prompt continuation.
- [ ] Exec-mode token accumulation is still correct for Claude and intentionally defined for Codex.
- [ ] Final message resolution still works when the harness does not provide streamed assistant text directly.
- [ ] Failure cases still map to the right exit codes:
  - [ ] process failure
  - [ ] policy failure
  - [ ] timeout
  - [ ] output failure

## 9. Interactive Shell

- [ ] `useHarnessProcess()` remains adapter-driven and does not grow harness branches.
- [ ] Runtime provider behavior is still harness-agnostic from app code.
- [ ] Permission and question dialogs still receive the same normalized event shape they expect.
- [ ] Startup diagnostics behavior is unchanged unless explicitly reviewed.
- [ ] Session picker, session restore, and header model still behave correctly with both harnesses.

## 10. Testing

- [ ] New adapter logic has direct unit coverage.
- [ ] Registry changes are covered by [src/harnesses/registry.test.ts](/home/nadeemm/athena/cli/src/harnesses/registry.test.ts) or equivalent.
- [ ] Runtime translator changes have focused tests at the harness layer.
- [ ] Exec-mode changes are covered in [src/app/exec/runner.test.ts](/home/nadeemm/athena/cli/src/app/exec/runner.test.ts).
- [ ] Bootstrap/config changes are covered in [src/app/bootstrap/bootstrapConfig.test.ts](/home/nadeemm/athena/cli/src/app/bootstrap/bootstrapConfig.test.ts) and related config tests.
- [ ] Deleted abstractions have deleted tests; no dead tests remain for removed layers.
- [ ] `npm run build` passes after the change.

## 11. Regression Search

Run and review these searches before merge:

- [ ] `rg -n "CodexRuntime|if \\(.*openai-codex|=== 'openai-codex'|isCodex" src/app src/harnesses`
- [ ] `rg -n "processProfiles|resolveHarnessProcessProfile" src`
- [ ] `rg -n "codex/process|claude/process" src/harnesses`
- [ ] `rg -n "stop.request" src/harnesses/codex src/core`

## 12. Documentation

- [ ] If the implementation changes the target architecture, update [docs/plans/2026-03-10-codex-harness-design.md](/home/nadeemm/athena/cli/docs/plans/2026-03-10-codex-harness-design.md).
- [ ] If old structure references become stale in docs, clean them up in the same change.
- [ ] If generated Codex protocol snapshots are introduced, document how they are refreshed.

## 13. Merge Gate

The change is ready only if all of the following are true:

- [ ] Adapter boundary remains the only app-facing harness integration surface.
- [ ] Claude behavior is not regressed.
- [ ] Codex behavior is more correct than before, not just differently abstracted.
- [ ] Build passes.
- [ ] Focused tests pass.
- [ ] Any remaining intentional gaps are documented explicitly.
