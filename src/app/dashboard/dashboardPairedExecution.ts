import type {
	InstanceSocketClient,
	InstanceSocketFrame,
	InstanceSocketLogger,
} from './instanceSocketClient';
import type {DashboardDecisionInbox} from './dashboardDecisionInbox';
import type {ExecuteRemoteAssignmentInput} from './remoteRunExecutor';

type JobAssignmentFrame = Extract<
	InstanceSocketFrame,
	{type: 'job_assignment'}
>;

export type DashboardPairedExecutionExecutor = (
	input: ExecuteRemoteAssignmentInput,
) => Promise<void>;

export type DashboardPairedExecutionRunRecord = {
	runId: string;
	startedAt: number;
	endedAt?: number;
	status: 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
	error?: string;
};

export type DashboardPairedExecutionOptions = {
	client: Pick<InstanceSocketClient, 'sendRunEvent' | 'sendDecisionAck'>;
	executor: DashboardPairedExecutionExecutor;
	projectDir: string;
	decisionInbox: DashboardDecisionInbox;
	log?: InstanceSocketLogger;
	maxConcurrentRuns?: number;
	now?: () => number;
	runHistoryLimit?: number;
};

export type DashboardPairedExecution = {
	handleFrame(frame: InstanceSocketFrame): boolean;
	snapshot(): {activeRuns: number; completedRuns: number};
	listRuns(options?: {
		active?: boolean;
		limit?: number;
	}): DashboardPairedExecutionRunRecord[];
	stop(): Promise<void>;
};

const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_RUN_HISTORY_LIMIT = 100;

export function createDashboardPairedExecution(
	options: DashboardPairedExecutionOptions,
): DashboardPairedExecution {
	const client = options.client;
	const executor = options.executor;
	const projectDir = options.projectDir;
	const decisionInbox = options.decisionInbox;
	const log = options.log ?? (() => {});
	const maxConcurrentRuns =
		options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
	const runHistoryLimit = options.runHistoryLimit ?? DEFAULT_RUN_HISTORY_LIMIT;
	const now = options.now ?? (() => Date.now());

	let completedRuns = 0;
	const active = new Map<
		string,
		{
			controller: AbortController;
			promise: Promise<void>;
			record: DashboardPairedExecutionRunRecord;
			runnerKey: string | undefined;
		}
	>();
	const activeByRunner = new Map<string | undefined, Set<string>>();
	const runHistory: DashboardPairedExecutionRunRecord[] = [];

	function recordRun(record: DashboardPairedExecutionRunRecord): void {
		runHistory.push(record);
		while (runHistory.length > runHistoryLimit) {
			runHistory.shift();
		}
	}

	function rejectAssignment(runId: string, reason: string): void {
		try {
			client.sendRunEvent({
				runId,
				seq: 0,
				ts: now(),
				kind: 'rejected',
				payload: {reason},
			});
		} catch (err) {
			log(
				'warn',
				`runtime daemon: failed to send rejected for ${runId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		recordRun({
			runId,
			startedAt: now(),
			endedAt: now(),
			status: 'rejected',
			error: reason,
		});
		log('warn', `run ${runId} rejected: ${reason}`);
	}

	function handleDecision(
		frame: Extract<InstanceSocketFrame, {type: 'dashboard_decision'}>,
	): void {
		decisionInbox.enqueue({
			athenaSessionId: frame.athenaSessionId,
			requestId: frame.requestId,
			decision: frame.decision,
			receivedAt: now(),
		});
		client.sendDecisionAck({
			athenaSessionId: frame.athenaSessionId,
			requestId: frame.requestId,
		});
	}

	function handleCancel(frame: Extract<InstanceSocketFrame, {type: 'cancel'}>) {
		const entry = active.get(frame.runId);
		if (!entry) return;
		entry.record.status = 'cancelled';
		entry.controller.abort();
	}

	function handleAssignment(frame: JobAssignmentFrame): void {
		if (active.has(frame.runId)) {
			rejectAssignment(
				frame.runId,
				`duplicate active assignment ${frame.runId}`,
			);
			return;
		}
		const runnerKey = frame.runnerId;
		const bucket = activeByRunner.get(runnerKey) ?? new Set<string>();
		if (bucket.size >= maxConcurrentRuns) {
			rejectAssignment(
				frame.runId,
				`runtime daemon at concurrency cap (${maxConcurrentRuns}) for runner ${runnerKey ?? '<legacy>'}`,
			);
			return;
		}

		const controller = new AbortController();
		const record: DashboardPairedExecutionRunRecord = {
			runId: frame.runId,
			startedAt: now(),
			status: 'running',
		};
		recordRun(record);
		bucket.add(frame.runId);
		activeByRunner.set(runnerKey, bucket);

		const promise = executor({
			frame,
			client,
			projectDir,
			log,
			abortSignal: controller.signal,
			decisionInbox,
		})
			.then(() => {
				if (record.status === 'running') record.status = 'completed';
			})
			.catch(err => {
				if (record.status === 'running') {
					record.status = 'failed';
				}
				record.error = err instanceof Error ? err.message : String(err);
				log(
					'error',
					`run ${frame.runId} failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			})
			.finally(() => {
				record.endedAt = now();
				completedRuns += 1;
				active.delete(frame.runId);
				const remaining = activeByRunner.get(runnerKey);
				if (remaining) {
					remaining.delete(frame.runId);
					if (remaining.size === 0) activeByRunner.delete(runnerKey);
				}
			});
		active.set(frame.runId, {controller, promise, record, runnerKey});
	}

	return {
		handleFrame(frame) {
			if (frame.type === 'dashboard_decision') {
				handleDecision(frame);
				return true;
			}
			if (frame.type === 'cancel') {
				handleCancel(frame);
				return true;
			}
			if (frame.type === 'job_assignment') {
				handleAssignment(frame);
				return true;
			}
			return false;
		},
		snapshot() {
			return {
				activeRuns: active.size,
				completedRuns,
			};
		},
		listRuns(opts = {}) {
			let out = runHistory.slice();
			if (typeof opts.limit === 'number' && opts.limit > 0) {
				out = out.slice(-opts.limit);
			}
			if (opts.active) {
				out = out.filter(r => r.status === 'running');
			}
			return out;
		},
		async stop() {
			for (const run of active.values()) {
				run.controller.abort();
			}
			await Promise.allSettled([...active.values()].map(run => run.promise));
		},
	};
}
