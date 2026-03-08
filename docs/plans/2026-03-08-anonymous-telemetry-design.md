# Anonymous Telemetry Design

**Date:** 2026-03-08
**Status:** Approved

## Overview

Add anonymous, opt-out telemetry to Athena CLI using PostHog to capture usage analytics, stability metrics, and growth data — without collecting any personally identifiable information.

## Goals

- **Usage:** Understand which features/harnesses/workflows are used
- **Stability:** Capture crash reports and error rates
- **Growth:** Track installs and active usage

## Non-Goals

- No PII collection (no prompts, file contents, file paths, API keys, project names)
- No IP address tracking (PostHog geoip disabled)

## Module Structure

```
src/infra/telemetry/
├── client.ts        # PostHog client init, shutdown, opt-out check
├── events.ts        # Event tracking functions
├── identity.ts      # Anonymous device ID generation & persistence
└── index.ts         # Public API barrel export
```

Lives in `infra/` layer — importable by `app/` only (respects boundary rules).

## Identity & Privacy

- **Anonymous Device ID:** Random UUIDv4, generated on first run, stored in global config (`~/.config/athena/config.json` as `deviceId`)
- **Not derived** from hardware, username, or any PII
- **PostHog config:** `disableGeoip: true`, write-only API key embedded in source
- **Data never sent** if user opts out or network is unavailable

## Opt-Out Mechanism

Three ways to disable:

1. CLI command: `athena telemetry disable` / `athena telemetry enable`
2. Config flag: `telemetry: false` in `AthenaConfig`
3. Env var: `ATHENA_TELEMETRY_DISABLED=1`

Default: **enabled** (opt-out model, industry standard for CLI tools).

## Events

| Event Name            | Trigger                  | Properties                                                                                |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `app.installed`       | First run (setup wizard) | `version`, `os`, `nodeVersion`, `harness`                                                 |
| `app.launched`        | Every launch             | `version`, `os`, `nodeVersion`, `harness`                                                 |
| `session.started`     | Session begins           | `harness`, `workflow`, `model`                                                            |
| `session.ended`       | Session ends             | `durationMs`, `toolCallCount`, `subagentCount`, `permissionsAllowed`, `permissionsDenied` |
| `app.error`           | Unhandled exception      | `errorName`, `stackTrace` (sanitized, no user file paths)                                 |
| `telemetry.opted_out` | User disables telemetry  | _(none — last event sent)_                                                                |

## Integration Points

1. **Bootstrap** (`src/app/bootstrap/`) — `initTelemetry()`, generate device ID if missing
2. **Setup wizard** (`src/setup/`) — fire `app.installed`, show telemetry notice
3. **AppShell** (`src/app/shell/`) — fire `session.started` / `session.ended`
4. **Error boundary** — fire `app.error` on unhandled exceptions
5. **CLI command** — new `telemetry` subcommand for enable/disable
6. **Process exit** — `shutdownTelemetry()` to flush pending events

## First-Run Notice

```
Athena collects anonymous usage data to improve the product.
Run 'athena telemetry disable' or set ATHENA_TELEMETRY_DISABLED=1 to opt out.
```

## Dependency

- `posthog-node` (official PostHog Node.js SDK)

## Approach

Direct lightweight client (Approach A) — thin module wrapping PostHog SDK. Events batched and flushed asynchronously by the SDK. No local buffering or event bus coupling.
