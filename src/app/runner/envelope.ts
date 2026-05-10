/**
 * Inbound runner envelopes carried as JSON text on `dispatch.turn` payloads
 * to a harness child registered under an `attachmentId`. The supervisor's
 * RunnerAdapter encodes dashboard `job_assignment` and `cancel` frames into
 * these envelopes; the child must distinguish them from regular chat text so
 * runner traffic routes to the assignment handler instead of `spawnHarness`.
 *
 * Be permissive: any input that does not match a recognised runner envelope
 * is treated as chat (returns `null`), so unrelated traffic falls through.
 */

export type RunnerEnvelope =
	| {kind: 'job_assignment'; runId: string; runSpec?: unknown}
	| {kind: 'cancel'; runId: string};

export function parseRunnerEnvelope(text: string): RunnerEnvelope | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const obj = value as Record<string, unknown>;
	const runId = obj['runId'];
	if (typeof runId !== 'string' || runId.length === 0) return null;
	const kind = obj['kind'];
	if (kind === 'job_assignment') {
		return {kind, runId, runSpec: obj['runSpec']};
	}
	if (kind === 'cancel') {
		return {kind, runId};
	}
	return null;
}
