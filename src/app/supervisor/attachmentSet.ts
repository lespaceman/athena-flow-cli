/**
 * Pool of `AttachmentRunner` instances keyed by attachmentId. The supervisor
 * calls `reconcile(desired)` whenever the dashboard's attachment list changes
 * (initial pair, then every `attachments.changed`). Reconciliation:
 *
 *   - Adds a runner (and starts it) for every desired attachmentId not present.
 *   - Stops the runner with reason `'detach'` for every previously-present
 *     attachmentId no longer desired.
 *   - Replaces a runner whose `runnerId` changed under the same attachmentId
 *     (rare; the dashboard normally rotates `attachmentId` instead, but the
 *     pool defends against it so a misconfiguration doesn't silently route to
 *     the old runner).
 *
 * `shutdown()` stops every running runner with reason `'shutdown'`.
 *
 * See ADR 0001 phase 5.
 */

import type {AttachmentRunner} from './attachmentRunner';

export type DesiredAttachment = {
	attachmentId: string;
	runnerId: string;
};

export type CreateAttachmentRunnerInput = DesiredAttachment;

export type AttachmentSetOptions = {
	createRunner: (input: CreateAttachmentRunnerInput) => AttachmentRunner;
};

export type AttachmentSet = {
	reconcile(desired: ReadonlyArray<DesiredAttachment>): Promise<void>;
	list(): DesiredAttachment[];
	shutdown(): Promise<void>;
};

export function createAttachmentSet(opts: AttachmentSetOptions): AttachmentSet {
	const runners = new Map<string, AttachmentRunner>();

	async function stopRunner(
		runner: AttachmentRunner,
		reason: 'detach' | 'shutdown',
	): Promise<void> {
		try {
			await runner.stop(reason);
		} catch {
			// best-effort — supervisor surfaces individual failures via runner exit handlers
		}
	}

	return {
		async reconcile(desired): Promise<void> {
			const desiredById = new Map(desired.map(d => [d.attachmentId, d]));

			const stops: Promise<void>[] = [];
			for (const [id, runner] of runners) {
				const want = desiredById.get(id);
				if (!want || want.runnerId !== runner.runnerId) {
					runners.delete(id);
					stops.push(stopRunner(runner, 'detach'));
				}
			}
			await Promise.all(stops);

			for (const want of desired) {
				if (runners.has(want.attachmentId)) continue;
				const runner = opts.createRunner({
					attachmentId: want.attachmentId,
					runnerId: want.runnerId,
				});
				runners.set(want.attachmentId, runner);
				await runner.start();
			}
		},
		list(): DesiredAttachment[] {
			return [...runners.values()].map(r => ({
				attachmentId: r.attachmentId,
				runnerId: r.runnerId,
			}));
		},
		async shutdown(): Promise<void> {
			const stops: Promise<void>[] = [];
			for (const runner of runners.values()) {
				stops.push(stopRunner(runner, 'shutdown'));
			}
			runners.clear();
			await Promise.all(stops);
		},
	};
}
