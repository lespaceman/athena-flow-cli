import {
	createInstanceSocketClient,
	type InstanceSocketClient,
	type InstanceSocketLogger,
} from './instanceSocketClient';
import {
	executeRemoteAssignment,
	type ExecuteRemoteAssignmentInput,
} from './remoteRunExecutor';
import {
	refreshDashboardAccessToken,
	type DashboardAccessToken,
} from '../../infra/config/dashboardAuth';
import {
	type DashboardClientConfig,
	readDashboardClientConfig,
} from '../../infra/config/dashboardClient';
import {
	type AttachmentMirror,
	writeAttachmentMirror,
} from '../../infra/config/attachmentMirror';
import {
	reconcileConsoleSidecars,
	type ReconcileInput,
	type ReconcileResult,
} from './consoleSidecarReconciler';
import {channelSidecarDir} from '../../infra/config/channels';
import {
	createDashboardFeedOutbox,
	type DashboardFeedOutbox,
} from './dashboardFeedPublisher';
import {
	createDashboardDecisionInbox,
	type DashboardDecisionInbox,
} from './dashboardDecisionInbox';

type RuntimeDaemonAssignmentExecutor = (
	input: ExecuteRemoteAssignmentInput,
) => Promise<void>;

export type RuntimeDaemonRunRecord = {
	runId: string;
	startedAt: number;
	endedAt?: number;
	status: 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected';
	error?: string;
};

export type RuntimeDaemonSnapshot = {
	startedAt: number;
	socketConnected: boolean;
	lastFrameAt?: number;
	activeRuns: number;
	completedRuns: number;
	instanceId?: string;
	dashboardUrl?: string;
	/**
	 * Token-refresh health. `cooldownUntilMs` is set when the circuit breaker
	 * trips (refresh failures saturate the window). Surfaces in `dashboard
	 * status` so the user understands why the socket is offline.
	 */
	refreshState?: {
		recentFailures: number;
		cooldownUntilMs?: number;
	};
};

export type RuntimeDaemonHandle = {
	snapshot(): RuntimeDaemonSnapshot;
	listRuns(options?: {
		active?: boolean;
		limit?: number;
	}): RuntimeDaemonRunRecord[];
	stop(reason?: string): Promise<void>;
};

export type RunDashboardRuntimeDaemonOptions = {
	readConfig?: () => DashboardClientConfig | null;
	refreshAccessToken?: () => Promise<DashboardAccessToken>;
	makeInstanceSocketClient?: (opts: {
		dashboardUrl: string;
		instanceId: string;
		accessToken: string;
		log: InstanceSocketLogger;
	}) => InstanceSocketClient;
	executeRemoteAssignment?: RuntimeDaemonAssignmentExecutor;
	projectDir?: string;
	log?: InstanceSocketLogger;
	reconnectDelaysMs?: number[];
	/**
	 * Cap on parallel exec sessions. The dashboard already queues offline
	 * assignments; the cap protects against the local box being overwhelmed
	 * when a runner has high parallelism configured. Default 1.
	 */
	maxConcurrentRuns?: number;
	/**
	 * Lead time before access-token expiry to schedule a proactive refresh,
	 * in seconds. A fresh token replaces the cached value so the next
	 * reconnect doesn't race the expiry. Default 60s.
	 */
	refreshLeadSec?: number;
	/**
	 * Refresh circuit-breaker. After `refreshFailureLimit` failures within
	 * `refreshFailureWindowMs`, the daemon sleeps `refreshCooldownMs` before
	 * retrying. Refresh tokens are single-use; a tight retry loop will burn
	 * the rotation history and force the user to re-pair. Defaults: 5
	 * failures within 5 minutes triggers a 5-minute cooldown.
	 */
	refreshFailureLimit?: number;
	refreshFailureWindowMs?: number;
	refreshCooldownMs?: number;
	now?: () => number;
	/**
	 * Cap on the `runs` ring buffer. Default 100.
	 */
	runHistoryLimit?: number;
	/**
	 * Test seam. Production uses `writeAttachmentMirror`. Called whenever the
	 * dashboard pushes `attachments.changed` so the local mirror stays in
	 * sync without requiring a re-pair.
	 */
	writeMirror?: (mirror: AttachmentMirror) => void;
	/**
	 * Test seam. Production uses `reconcileConsoleSidecars`. Called whenever
	 * `attachments.changed` arrives so the local channels directory stays in
	 * sync with the dashboard's runner list without manual `console link`.
	 */
	reconcileChannels?: (input: ReconcileInput) => ReconcileResult;
	/**
	 * Production reaches the gateway daemon over its UDS socket. Tests inject
	 * a mock so the runtime daemon can be exercised without a live gateway.
	 * Called only when reconciliation actually changed the channels directory.
	 */
	reloadGatewayChannels?: () => Promise<{ok: boolean; message: string}>;
	/** Override channel sidecar directory; defaults to `channelSidecarDir()`. */
	channelDir?: () => string;
	/**
	 * Durable queue of local feed events waiting for dashboard ACK. Production
	 * uses the dashboard state dir; tests inject a temp database.
	 */
	feedOutbox?: DashboardFeedOutbox;
	/** Poll interval for queued feed events. Default 1000ms. */
	feedDrainIntervalMs?: number;
	/** Durable local inbox for dashboard permission/question decisions. */
	decisionInbox?: DashboardDecisionInbox;
};

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const DEFAULT_REFRESH_LEAD_SEC = 60;
const DEFAULT_REFRESH_FAILURE_LIMIT = 5;
const DEFAULT_REFRESH_FAILURE_WINDOW_MS = 5 * 60_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RUN_HISTORY_LIMIT = 100;
const DEFAULT_FEED_DRAIN_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

export async function runDashboardRuntimeDaemon(
	options: RunDashboardRuntimeDaemonOptions = {},
): Promise<RuntimeDaemonHandle> {
	const readConfig = options.readConfig ?? (() => readDashboardClientConfig());
	const refreshAccessTokenFn =
		options.refreshAccessToken ?? (async () => refreshDashboardAccessToken({}));
	const makeClient =
		options.makeInstanceSocketClient ??
		(opts =>
			createInstanceSocketClient({
				dashboardUrl: opts.dashboardUrl,
				instanceId: opts.instanceId,
				accessToken: opts.accessToken,
				log: opts.log,
			}));
	const executor = options.executeRemoteAssignment ?? executeRemoteAssignment;
	const projectDir = options.projectDir ?? process.cwd();
	const log = options.log ?? (() => {});
	const reconnectDelays =
		options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
	const maxConcurrentRuns =
		options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
	const refreshLeadSec = options.refreshLeadSec ?? DEFAULT_REFRESH_LEAD_SEC;
	const refreshFailureLimit =
		options.refreshFailureLimit ?? DEFAULT_REFRESH_FAILURE_LIMIT;
	const refreshFailureWindowMs =
		options.refreshFailureWindowMs ?? DEFAULT_REFRESH_FAILURE_WINDOW_MS;
	const refreshCooldownMs =
		options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
	const runHistoryLimit = options.runHistoryLimit ?? DEFAULT_RUN_HISTORY_LIMIT;
	const now = options.now ?? (() => Date.now());
	const writeMirror = options.writeMirror ?? writeAttachmentMirror;
	const reconcileChannels =
		options.reconcileChannels ?? reconcileConsoleSidecars;
	const reloadGatewayChannels = options.reloadGatewayChannels;
	const getChannelDir = options.channelDir ?? channelSidecarDir;
	const feedOutbox = options.feedOutbox ?? createDashboardFeedOutbox();
	const decisionInbox = options.decisionInbox ?? createDashboardDecisionInbox();
	const feedDrainIntervalMs =
		options.feedDrainIntervalMs ?? DEFAULT_FEED_DRAIN_INTERVAL_MS;

	const startedAt = now();
	let stopped = false;
	let reconnectAttempt = 0;
	let client: InstanceSocketClient | null = null;
	let currentInstanceId: string | undefined;
	let currentDashboardUrl: string | undefined;
	let lastFrameAt: number | undefined;
	let completedRuns = 0;
	let refreshTimer: NodeJS.Timeout | null = null;
	let feedDrainTimer: NodeJS.Timeout | null = null;
	const refreshFailures: number[] = [];
	let cooldownUntil = 0;

	const active = new Map<
		string,
		{
			controller: AbortController;
			promise: Promise<void>;
			record: RuntimeDaemonRunRecord;
			runnerKey: string | undefined;
		}
	>();
	// Per-runner active-run buckets. A `runnerId` of undefined shares one
	// fallback bucket — preserves single-runtime semantics for dashboards
	// predating phase-1 of the supervisor work.
	const activeByRunner = new Map<string | undefined, Set<string>>();
	const runHistory: RuntimeDaemonRunRecord[] = [];

	function recordRun(record: RuntimeDaemonRunRecord): void {
		runHistory.push(record);
		while (runHistory.length > runHistoryLimit) {
			runHistory.shift();
		}
	}

	function nextReconnectDelay(): number {
		if (reconnectDelays.length === 0) return 0;
		const delayMs =
			reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ??
			0;
		reconnectAttempt += 1;
		return delayMs;
	}

	function clearRefreshTimer(): void {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function clearFeedDrainTimer(): void {
		if (feedDrainTimer) {
			clearInterval(feedDrainTimer);
			feedDrainTimer = null;
		}
	}

	function drainFeedOutbox(): void {
		const current = client;
		if (!current) return;
		const rows = feedOutbox.pendingBatch({limit: 100, now: now()});
		for (const row of rows) {
			current.sendFeedEvent({
				deliverySeq: row.deliverySeq,
				envelope: row.envelope,
			});
			const retryDelayMs = Math.min(30_000, (row.attempt + 1) * 1_000);
			feedOutbox.markAttempted({
				deliverySeq: row.deliverySeq,
				nextAttemptAt: now() + retryDelayMs,
			});
		}
	}

	function startFeedDrainTimer(): void {
		clearFeedDrainTimer();
		const timer = setInterval(drainFeedOutbox, feedDrainIntervalMs);
		timer.unref();
		feedDrainTimer = timer;
		drainFeedOutbox();
	}

	function scheduleRefresh(expiresInSec: number): void {
		clearRefreshTimer();
		if (!Number.isFinite(expiresInSec) || expiresInSec <= refreshLeadSec) {
			return;
		}
		const ms = (expiresInSec - refreshLeadSec) * 1_000;
		const timer = setTimeout(() => {
			void proactiveRefresh();
		}, ms);
		timer.unref();
		refreshTimer = timer;
	}

	async function proactiveRefresh(): Promise<void> {
		if (stopped) return;
		try {
			const token = await refreshAccessTokenFn();
			refreshFailures.length = 0;
			scheduleRefresh(token.expiresInSec);
			log('debug', `runtime daemon refreshed token (proactive)`);
		} catch (err) {
			noteRefreshFailure();
			log(
				'warn',
				`runtime daemon proactive refresh failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	function noteRefreshFailure(): void {
		const ts = now();
		refreshFailures.push(ts);
		while (
			refreshFailures.length > 0 &&
			ts - (refreshFailures[0] ?? 0) > refreshFailureWindowMs
		) {
			refreshFailures.shift();
		}
		if (refreshFailures.length >= refreshFailureLimit) {
			cooldownUntil = ts + refreshCooldownMs;
			refreshFailures.length = 0;
			log(
				'warn',
				`runtime daemon refresh circuit-broken; cooling down for ${Math.round(
					refreshCooldownMs / 1_000,
				)}s`,
			);
		}
	}

	function rejectAssignment(
		client_: InstanceSocketClient,
		runId: string,
		reason: string,
	): void {
		try {
			client_.sendRunEvent({
				runId,
				seq: 0,
				ts: now(),
				kind: 'rejected',
				payload: {reason},
			});
		} catch (err) {
			// The dashboard will time the lease out anyway, but a silent failure
			// makes debugging "why is my run still showing as running?" much
			// harder. Log so an operator can correlate.
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

	async function connectOnce(): Promise<void> {
		const config = readConfig();
		if (!config) {
			throw new Error(
				'dashboard runtime daemon: not paired. Run "drisp dashboard pair" first.',
			);
		}
		// If the circuit breaker has tripped, sleep until the cooldown expires
		// rather than throwing immediately. Throwing inside reconnectLoop with a
		// 0ms backoff turns into a tight microtask spin; sleeping yields to
		// other timers and lets `stop()` interrupt cleanly.
		if (cooldownUntil > now()) {
			const remainingMs = Math.max(0, cooldownUntil - now());
			log(
				'warn',
				`runtime daemon: refresh cooldown active, sleeping ${Math.ceil(
					remainingMs / 1_000,
				)}s`,
			);
			await delay(remainingMs);
			if (stopped) return;
		}
		let token: DashboardAccessToken;
		try {
			token = await refreshAccessTokenFn();
			refreshFailures.length = 0;
		} catch (err) {
			noteRefreshFailure();
			throw err;
		}
		const next = makeClient({
			dashboardUrl: config.dashboardUrl,
			instanceId: token.instanceId,
			accessToken: token.accessToken,
			log,
		});
		next.onFrame(frame => {
			lastFrameAt = now();
			if (frame.type === 'attachments.changed') {
				try {
					writeMirror({
						instanceId: token.instanceId,
						fetchedAt: now(),
						attachments: frame.attachments.map(a => ({
							runnerId: a.runnerId,
							...(a.name !== undefined ? {name: a.name} : {}),
							...(a.executionTarget !== undefined
								? {executionTarget: a.executionTarget}
								: {}),
							...(a.remoteInstanceId !== undefined
								? {remoteInstanceId: a.remoteInstanceId}
								: {}),
						})),
					});
				} catch (err) {
					log(
						'warn',
						`runtime daemon: failed to write attachment mirror: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
				let reconciled: ReconcileResult | null = null;
				try {
					reconciled = reconcileChannels({
						channelDir: getChannelDir(),
						dashboardUrl: config.dashboardUrl,
						desired: frame.attachments.map(a => ({runnerId: a.runnerId})),
					});
				} catch (err) {
					log(
						'warn',
						`runtime daemon: failed to reconcile console sidecars: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
				if (
					reconciled &&
					(reconciled.written.length > 0 || reconciled.removed.length > 0) &&
					reloadGatewayChannels
				) {
					void reloadGatewayChannels().catch(err => {
						log(
							'warn',
							`runtime daemon: failed to reload gateway channels: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					});
				}
				return;
			}
			if (frame.type === 'feed_ack') {
				feedOutbox.markAcked({
					...(typeof frame.deliverySeq === 'number'
						? {deliverySeq: frame.deliverySeq}
						: {}),
					...(typeof frame.eventId === 'string'
						? {eventId: frame.eventId}
						: {}),
				});
				return;
			}
			if (frame.type === 'dashboard_decision') {
				decisionInbox.enqueue({
					athenaSessionId: frame.athenaSessionId,
					requestId: frame.requestId,
					decision: frame.decision,
					receivedAt: now(),
				});
				return;
			}
			if (frame.type === 'cancel') {
				const entry = active.get(frame.runId);
				if (entry) {
					entry.record.status = 'cancelled';
					entry.controller.abort();
				}
				return;
			}
			if (frame.type !== 'job_assignment') return;
			if (active.has(frame.runId)) return;
			const runnerKey = frame.runnerId;
			const bucket = activeByRunner.get(runnerKey) ?? new Set<string>();
			if (bucket.size >= maxConcurrentRuns) {
				rejectAssignment(
					next,
					frame.runId,
					`runtime daemon at concurrency cap (${maxConcurrentRuns}) for runner ${runnerKey ?? '<legacy>'}`,
				);
				return;
			}
			const controller = new AbortController();
			const record: RuntimeDaemonRunRecord = {
				runId: frame.runId,
				startedAt: now(),
				status: 'running',
			};
			recordRun(record);
			bucket.add(frame.runId);
			activeByRunner.set(runnerKey, bucket);
			const promise = executor({
				frame,
				client: next,
				projectDir,
				log,
				abortSignal: controller.signal,
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
		});
		next.onClose(reason => {
			if (stopped || client !== next) return;
			log('warn', `instance socket closed: ${reason}`);
			client = null;
			currentInstanceId = undefined;
			clearRefreshTimer();
			clearFeedDrainTimer();
			void reconnectLoop();
		});
		await next.connect();
		client = next;
		currentInstanceId = token.instanceId;
		currentDashboardUrl = config.dashboardUrl;
		reconnectAttempt = 0;
		scheduleRefresh(token.expiresInSec);
		startFeedDrainTimer();
		log('info', `dashboard runtime daemon connected as ${token.instanceId}`);
	}

	async function reconnectLoop(): Promise<void> {
		while (!stopped && client === null) {
			const waitMs = nextReconnectDelay();
			if (waitMs > 0) await delay(waitMs);
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- values may change during await
			if (stopped || client !== null) return;
			try {
				await connectOnce();
				return;
			} catch (err) {
				log(
					'warn',
					`dashboard runtime daemon reconnect failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	}

	await connectOnce();

	return {
		snapshot(): RuntimeDaemonSnapshot {
			const refreshState =
				refreshFailures.length > 0 || cooldownUntil > now()
					? {
							recentFailures: refreshFailures.length,
							...(cooldownUntil > now()
								? {cooldownUntilMs: cooldownUntil}
								: {}),
						}
					: undefined;
			return {
				startedAt,
				socketConnected: client !== null,
				...(lastFrameAt !== undefined ? {lastFrameAt} : {}),
				activeRuns: active.size,
				completedRuns,
				...(currentInstanceId ? {instanceId: currentInstanceId} : {}),
				...(currentDashboardUrl ? {dashboardUrl: currentDashboardUrl} : {}),
				...(refreshState ? {refreshState} : {}),
			};
		},
		listRuns(opts = {}): RuntimeDaemonRunRecord[] {
			// Limit applies to the most recent N runs; the active filter then
			// narrows that window. This matches the user's intuition for
			// `dashboard runs --active --limit 5`: "show running runs from the
			// last 5", not "last 5 from the entire history of running runs".
			let out = runHistory.slice();
			if (typeof opts.limit === 'number' && opts.limit > 0) {
				out = out.slice(-opts.limit);
			}
			if (opts.active) {
				out = out.filter(r => r.status === 'running');
			}
			return out;
		},
		async stop(reason = 'stopped') {
			stopped = true;
			clearRefreshTimer();
			clearFeedDrainTimer();
			for (const run of active.values()) {
				run.controller.abort();
			}
			const current = client;
			client = null;
			current?.close(reason);
			await Promise.allSettled([...active.values()].map(run => run.promise));
		},
	};
}
