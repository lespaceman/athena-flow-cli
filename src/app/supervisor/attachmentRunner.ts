/**
 * Per-attachment harness child supervisor.
 *
 * Owns the lifecycle of one harness subprocess bound to a single Attachment.
 * The supervisor (`src/app/entry/supervisor.tsx`) constructs one runner per
 * attachment; each runner spawns a `drisp` child with `--attachment-id <id>`
 * so the child's SessionBridge registers under the matching gateway slot.
 *
 * See ADR 0001 phase 5.
 */

import type {EventEmitter} from 'node:events';

export type AttachmentRunnerStopReason = 'detach' | 'shutdown' | 'crash';

export type AttachmentRunnerChild = Pick<EventEmitter, 'on' | 'once'> & {
	pid?: number;
	kill(signal?: NodeJS.Signals): boolean;
};

export type SpawnAttachmentChild = (args: string[]) => AttachmentRunnerChild;

export type AttachmentRunnerOptions = {
	attachmentId: string;
	runnerId: string;
	/**
	 * Test seam. Production wires this to `child_process.spawn(process.execPath,
	 * [cliEntry, ...args], {stdio: 'inherit'})`. The factory must produce a
	 * child that emits `exit` with `(code, signal)` when it terminates.
	 */
	spawnChild: SpawnAttachmentChild;
	/**
	 * Extra args appended after the runner's own --attachment-id/--runner pair.
	 * Lets the supervisor pass through e.g. `--project-dir` from its own argv.
	 */
	extraArgs?: ReadonlyArray<string>;
};

export type ChildExitEvent = {
	code: number;
	signal: NodeJS.Signals | null;
};

export type AttachmentRunner = {
	readonly attachmentId: string;
	readonly runnerId: string;
	start(): Promise<void>;
	stop(reason: AttachmentRunnerStopReason): Promise<void>;
	onChildExit(handler: (event: ChildExitEvent) => void): void;
};

export function createAttachmentRunner(
	opts: AttachmentRunnerOptions,
): AttachmentRunner {
	const exitHandlers = new Set<(event: ChildExitEvent) => void>();
	let child: AttachmentRunnerChild | null = null;
	let exited: Promise<ChildExitEvent> | null = null;

	function spawn(): void {
		const args = [
			'--attachment-id',
			opts.attachmentId,
			'--runner',
			opts.runnerId,
			...(opts.extraArgs ?? []),
		];
		const next = opts.spawnChild(args);
		exited = new Promise<ChildExitEvent>(resolve => {
			next.once(
				'exit',
				(code: number | null, signal: NodeJS.Signals | null) => {
					const event: ChildExitEvent = {code: code ?? 0, signal};
					if (child === next) {
						child = null;
						exited = null;
					}
					for (const handler of exitHandlers) handler(event);
					resolve(event);
				},
			);
		});
		child = next;
	}

	return {
		attachmentId: opts.attachmentId,
		runnerId: opts.runnerId,
		async start(): Promise<void> {
			if (child) return;
			spawn();
		},
		async stop(_reason: AttachmentRunnerStopReason): Promise<void> {
			const current = child;
			const wait = exited;
			if (!current) return;
			current.kill('SIGTERM');
			await wait;
		},
		onChildExit(handler): void {
			exitHandlers.add(handler);
		},
	};
}
