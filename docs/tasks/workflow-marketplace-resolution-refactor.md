# Workflow Marketplace Resolution And Upgrade Refactor

**Created:** 2026-04-17
**Status:** Proposed

---

## Problem Statement

`workflow install`, `workflow search`, `workflow resolve`, and `workflow upgrade`
currently use related but different source-resolution rules. That makes workflow
origin and upgrade behavior feel unreliable, especially when:

- the same workflow name exists in multiple configured marketplaces
- a local marketplace checkout contains the same workflow as a remote source
- a workflow was installed from a local marketplace and later upgraded
- users expect `workflow upgrade` to be the single explicit refresh path

We need a focused investigation and a proper refactor that makes marketplace
resolution deterministic, conflict-safe, easier to reason about, and fully
covered by tests.

---

## Small Investigation Summary

### 1. Bare-name install silently picks the first matching source

`resolveWorkflowInstallSourceFromSources()` iterates configured sources in order
and returns the first successful match, without detecting ambiguity across
multiple marketplaces.

Evidence:

- `src/infra/plugins/workflowSourceResolution.ts:255`
- `src/infra/plugins/__tests__/marketplace.test.ts:857`

This means `athena workflow install e2e-test-builder` can resolve to a
different source based only on marketplace ordering, even when another source
contains the same workflow name.

### 2. Search disambiguates duplicate names, but install does not

`workflow search` already prints source labels for duplicate names, which shows
the product knows ambiguity exists. But install/upgrade still use first-match
resolution.

Evidence:

- `src/app/entry/workflowCommand.ts:190`
- `src/app/entry/workflowCommand.test.ts:230`

That mismatch is a strong sign that the CLI UX and the underlying resolver are
out of sync.

### 3. Local marketplace installs lose marketplace identity

For local marketplace sources, the resolver returns the concrete
`workflow.json` path instead of a stable marketplace entry identity.

Evidence:

- `src/infra/plugins/workflowSourceResolution.ts:212`

Then `installWorkflow()` persists local installs as:

- `{kind: "local", path, repoDir?}`

while remote installs persist as:

- `{kind: "marketplace", ref}`

Evidence:

- `src/core/workflows/registry.ts:266`
- `src/core/workflows/types.ts:83`

So the same conceptual source, "a workflow entry from a marketplace", is stored
in two incompatible formats depending on whether the marketplace is remote or
local.

### 4. Upgrade behavior depends on how the workflow was originally installed

`updateWorkflow()` reuses whatever was stored in `source.json`:

- marketplace installs upgrade from `ref`
- local installs upgrade from raw `path`

Evidence:

- `src/core/workflows/registry.ts:303`
- `src/core/workflows/__tests__/registry.test.ts:590`

That means local marketplace installs upgrade by re-copying a file path, not by
re-resolving the workflow entry from the marketplace manifest. If a local
marketplace entry moves, is reorganized, or conflicts with another source, the
system has already lost the higher-level identity it would need to do the right
thing.

### 5. Resolve has upgrade-like side effects for remote sources, but not local ones

`resolveWorkflow()` calls `syncFromSource()`, which re-copies remote marketplace
workflows during resolution. Local workflow sources do not re-sync there.

Evidence:

- `src/core/workflows/registry.ts:86`
- `src/core/workflows/__tests__/registry.test.ts:143`

This creates inconsistent semantics:

- remote workflows can change during a read/resolve path
- local workflows only change during explicit install/upgrade

That makes `workflow upgrade` harder to reason about because refresh behavior is
split across more than one code path.

### 6. Marketplace refresh is implicit and hidden inside general resolution

Remote marketplace access goes through `ensureRepo()`, which pulls on every
cached access and swallows pull failures.

Evidence:

- `src/infra/plugins/marketplaceShared.ts:480`

So listing, resolving, installing, and upgrading all blur together with refresh
behavior, and the caller has no structured result describing what was actually
resolved or refreshed.

---

## Goals

- Make workflow source identity explicit and consistent for remote and local
  marketplace installs.
- Make resolution deterministic and fail loudly on conflicts instead of silently
  picking the first match.
- Make `workflow upgrade` refresh the workflow from its recorded source in a
  way that is easy to explain and test.
- Reduce architecture complexity by separating:
  - source discovery
  - ambiguity detection
  - refresh/pull
  - install snapshotting
  - upgrade/re-sync
- Preserve support for direct filesystem installs.
- Add strong automated test coverage for conflict and upgrade scenarios.

## Non-Goals

- Redesigning the workflow manifest schema unless required for source identity.
- Changing workflow execution/runtime semantics outside marketplace resolution.
- Removing support for local marketplaces or direct `workflow.json` installs.

---

## Proposed Design Direction

### 1. Introduce a canonical workflow source model

Add a structured resolution type that represents the selected workflow entry,
instead of collapsing early to a raw string path/ref.

Suggested shape:

```ts
type ResolvedWorkflowSource =
	| {
			kind: 'marketplace';
			marketplaceKind: 'remote' | 'local';
			workflowName: string;
			version?: string;
			repoIdentity: string; // owner/repo or canonical repo dir
			repoDir?: string;
			ref?: string;
			manifestPath: string;
			workflowPath: string;
	  }
	| {
			kind: 'filesystem';
			workflowPath: string;
	  };
```

Important rule: a workflow installed from a local marketplace should still be
stored as a marketplace-backed source, not downgraded to a raw file path.

### 2. Make ambiguity explicit

If multiple configured marketplaces expose the same workflow name and the user
provides a bare name, resolution should fail with a clear conflict error that
lists the candidates and how to disambiguate.

Examples:

- `e2e-test-builder` exists in `owner/repo-a` and `owner/repo-b`
- `e2e-test-builder` exists in `owner/repo` and `/local/workflow-marketplace`

The CLI should not silently pick whichever source appears first in config.

### 3. Separate refresh from resolve

Refactor the API so source resolution is mostly pure and side-effect free.

Suggested direction:

- `discoverMarketplaceWorkflows(...)`
- `resolveWorkflowSource(...)`
- `refreshMarketplaceSource(...)`
- `snapshotWorkflowToRegistry(...)`

Then `workflow upgrade` becomes explicit orchestration:

1. read stored source metadata
2. refresh the underlying marketplace if needed
3. re-resolve the exact workflow entry from stored identity
4. copy the latest workflow snapshot and assets
5. refresh pinned plugin packages if applicable

### 4. Stop mixing read-time resolution with upgrade-time mutation

`resolveWorkflow()` should ideally not rewrite installed files as a side effect.
If automatic refresh is still desired, it should move behind an explicit and
well-named path with tests that describe the behavior.

### 5. Unify marketplace identity rules for workflows and plugins where helpful

The workflow and plugin resolvers should share the same ideas for:

- marketplace identity
- local vs remote source normalization
- manifest-root resolution
- refresh behavior
- conflict/error reporting

This does not require a single module, but it should result in one coherent
architecture.

### 6. Migrate legacy `source.json` safely

Existing installs must continue to work. Add a compatibility layer that can read
old `source.json` records and rewrite them into the new structured format on
reinstall or upgrade.

---

## Implementation Workstreams

### Workstream 1: Reproduce and document the failure matrix

- Add a short investigation note to this task or a linked design doc covering:
  - duplicate workflow name across two remote marketplaces
  - duplicate workflow name across remote + local marketplace
  - install from local marketplace followed by upgrade
  - local marketplace entry moved or renamed after install
  - remote marketplace unavailable during resolve vs upgrade
- For each case, record:
  - current behavior
  - expected behavior
  - whether current behavior is intentional or accidental

### Workstream 2: Design the canonical source model

- Define new types for:
  - resolved install source
  - stored workflow source metadata
  - conflict/ambiguity errors
- Decide which fields are persisted in `source.json`
- Decide whether local marketplace upgrades resolve by:
  - workflow entry name + canonical repo dir
  - or workflow ref-like identity scoped to local marketplace

Deliverable:

- a short design note if the final structure differs materially from this task

### Workstream 3: Refactor resolution APIs

Likely files:

- `src/infra/plugins/workflowSourceResolution.ts`
- `src/infra/plugins/marketplace.ts`
- `src/infra/plugins/marketplaceShared.ts`

Tasks:

- return structured resolution results instead of raw strings where possible
- detect ambiguous bare-name matches across sources
- preserve version-aware matching
- normalize local marketplace identities to canonical repo roots
- keep direct file installs as an explicit filesystem-source path

### Workstream 4: Refactor workflow registry source persistence

Likely files:

- `src/core/workflows/types.ts`
- `src/core/workflows/registry.ts`

Tasks:

- persist normalized source metadata for remote and local marketplace installs
- add migration support for legacy `source.json`
- update install/upgrade flows to use structured source data
- ensure local marketplace upgrade re-resolves from marketplace identity rather
  than only reusing a stale file path

### Workstream 5: Clarify CLI behavior and error messages

Likely files:

- `src/app/entry/workflowCommand.ts`
- `src/app/entry/marketplaceCommand.ts`

Tasks:

- surface ambiguity errors clearly
- tell the user how to disambiguate
- make `workflow upgrade` output reflect actual behavior
- optionally add an explicit flag or syntax for choosing a marketplace when a
  bare name is ambiguous

### Workstream 6: Simplify refresh semantics

Tasks:

- decide whether `resolveWorkflow()` should stay side-effect free
- make remote marketplace refresh behavior explicit in command paths
- avoid hidden pull/update behavior where practical
- keep graceful offline behavior, but do not hide important resolution facts

### Workstream 7: Add comprehensive test coverage

Unit tests to extend:

- `src/infra/plugins/__tests__/marketplace.test.ts`
- `src/core/workflows/__tests__/registry.test.ts`
- `src/app/entry/workflowCommand.test.ts`

Recommended new coverage:

1. Installing a bare name that exists in multiple marketplaces returns a
   conflict error instead of first-match success.
2. Search still lists duplicate names with source labels.
3. Installing from a local marketplace stores marketplace-backed source
   identity, not only a raw path.
4. Upgrading a local marketplace install re-resolves the workflow entry from the
   recorded marketplace identity.
5. Upgrading a remote install continues to use the original marketplace even if
   marketplace ordering changes later.
6. Legacy `source.json` records still upgrade successfully.
7. Version-pinned installs still prefer the matching source and report helpful
   mismatch errors.
8. Offline or failed refresh preserves the installed snapshot but reports
   behavior consistently.
9. `resolveWorkflow()` does not unexpectedly mutate installed state unless that
   behavior remains intentional and is explicitly tested.

Recommended QA/manual additions:

- update `qa/manual-qa-test-cases.md` with duplicate-marketplace conflict cases
- add a regression case for local marketplace upgrade after entry movement

---

## Acceptance Criteria

- Installing a bare workflow name that matches multiple configured sources fails
  with a clear ambiguity error.
- A workflow installed from a local marketplace retains enough source identity
  to upgrade from that marketplace entry later.
- `workflow upgrade` refreshes from the originally selected source, not from
  whatever source currently appears first in config.
- Remote and local marketplace installs follow one coherent source model.
- Hidden resolution side effects are reduced or made explicit and documented.
- Existing installs remain upgradeable through legacy source metadata support.
- Automated tests cover conflicts, local/remote parity, version pins, upgrades,
  and offline behavior.

---

## Suggested Output Of This Task

This task should produce:

1. A short design note if the final source model changes materially from the
   proposal above.
2. The resolver and registry refactor.
3. Updated CLI error handling and messaging.
4. New automated tests and updated QA coverage.
