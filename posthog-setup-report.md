<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Drisp CLI. The project already had `posthog-node` installed and a complete telemetry layer (`src/infra/telemetry/`), so the integration built directly on top of that foundation — adding five new business-critical events, enabling exception autocapture, wiring early telemetry initialization for sub-commands that previously exited before telemetry was active, and setting up a PostHog dashboard with five insights.

**Files changed:**

- `src/infra/telemetry/events.ts` — Added `trackWorkflowCommand`, `trackDashboardPaired`, `trackDashboardUnpaired`, `trackSetupCompleted`, `trackExecCompleted`
- `src/infra/telemetry/index.ts` — Exported the five new track functions
- `src/infra/telemetry/client.ts` — Added `enableExceptionAutocapture: true` to the PostHog constructor
- `src/app/entry/cli.tsx` — Added `initEarlyTelemetry()` helper; wired tracking into the `workflow`, `dashboard`, and `exec` command branches
- `src/setup/SetupWizard.tsx` — Added `trackSetupCompleted` call when the wizard writes config and calls `onComplete`
- `.env` — Added `POSTHOG_API_KEY` (read by `tsup.config.ts` at build time via `define`)

| Event                | Description                                                                                                                 | File                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `workflow.command`   | User runs a workflow subcommand (install, remove, use, upgrade). Tracks adoption of the workflow system.                    | `src/app/entry/cli.tsx`     |
| `dashboard.paired`   | User successfully pairs this machine with a remote dashboard. Key conversion event for the dashboard feature.               | `src/app/entry/cli.tsx`     |
| `dashboard.unpaired` | User unpairs this machine from the dashboard.                                                                               | `src/app/entry/cli.tsx`     |
| `setup.completed`    | User completes the initial setup wizard. Top of the retention funnel — first-run completion rate.                           | `src/setup/SetupWizard.tsx` |
| `exec.completed`     | Exec command (non-interactive CI/script mode) finishes. Tracks power-user / automation adoption and exit code distribution. | `src/app/entry/cli.tsx`     |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard:** [Analytics basics](https://us.posthog.com/project/335318/dashboard/1551413)
- **Daily app launches** — [https://us.posthog.com/project/335318/insights/ojtUEJ4u](https://us.posthog.com/project/335318/insights/ojtUEJ4u)
- **Onboarding funnel: launch → setup completed** — [https://us.posthog.com/project/335318/insights/xzqnf795](https://us.posthog.com/project/335318/insights/xzqnf795)
- **Workflow commands by type** — [https://us.posthog.com/project/335318/insights/tEfViVJL](https://us.posthog.com/project/335318/insights/tEfViVJL)
- **Exec command exit code distribution** — [https://us.posthog.com/project/335318/insights/kiN0wiT2](https://us.posthog.com/project/335318/insights/kiN0wiT2)
- **Dashboard pairing adoption** — [https://us.posthog.com/project/335318/insights/QgzuTuIB](https://us.posthog.com/project/335318/insights/QgzuTuIB)

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
