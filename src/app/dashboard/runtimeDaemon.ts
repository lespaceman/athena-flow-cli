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
	createDashboardFeedOutbox,
	type DashboardFeedOutbox,
} from './dashboardFeedPublisher';
import {
	createDashboardDecisionInbox,
	type DashboardDecisionInbox,
} from './dashboardDecisionInbox';
import {
	createDashboardPairedExecution,
	type DashboardPairedExecutionRunRecord,
} from './dashboardPairedExecution';

type RuntimeDaemonAssignmentExecutor = (
	input: ExecuteRemoteAssignmentInput,
) => Promise<void>;

export type RuntimeDaemonRunRecord = DashboardPairedExecutionRunRecord;

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
	 * Durable queue of local feed events waiting for dashboard ACK. Production
	 * uses the dashboard state dir; tests inject a temp database.
	 */
	feedOutbox?: DashboardFeedOutbox;
	/** Poll interval for queued feed events. Default 1000ms. */
	feedDrainIntervalMs?: number;
	/** Durable local inbox for dashboard permission/question decisions. */
	decisionInbox?: DashboardDecisionInbox;
	/**
	 * Keep the long-running daemon alive when the first dashboard socket
	 * connection fails, so transient server/network failures recover through
	 * the normal reconnect loop. Foreground debugging can set false to fail
	 * fast and report the startup error directly.
	 */
	retryInitialConnect?: boolean;
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
	const feedOutbox = options.feedOutbox ?? createDashboardFeedOutbox();
	const decisionInbox = options.decisionInbox ?? createDashboardDecisionInbox();
	const feedDrainIntervalMs =
		options.feedDrainIntervalMs ?? DEFAULT_FEED_DRAIN_INTERVAL_MS;
	const retryInitialConnect = options.retryInitialConnect ?? true;

	const startedAt = now();
	let stopped = false;
	let reconnectAttempt = 0;
	let client: InstanceSocketClient | null = null;
	let lastSocketClient: InstanceSocketClient | null = null;
	let currentInstanceId: string | undefined;
	let currentDashboardUrl: string | undefined;
	let lastFrameAt: number | undefined;
	let refreshTimer: NodeJS.Timeout | null = null;
	let feedDrainTimer: NodeJS.Timeout | null = null;
	const refreshFailures: number[] = [];
	let cooldownUntil = 0;
	const executionClient: Pick<
		InstanceSocketClient,
		'sendRunEvent' | 'sendDecisionAck'
	> = {
		sendRunEvent(event) {
			const current = client ?? lastSocketClient;
			if (!current) {
				log(
					'warn',
					`instance socket dropped run_event (socket not connected): runId=${event.runId} kind=${event.kind}`,
				);
				return;
			}
			current.sendRunEvent(event);
		},
		sendDecisionAck(input) {
			const current = client;
			if (!current) return;
			current.sendDecisionAck(input);
		},
	};
	const pairedExecution = createDashboardPairedExecution({
		client: executionClient,
		executor,
		projectDir,
		decisionInbox,
		log,
		maxConcurrentRuns,
		now,
		runHistoryLimit,
	});

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
			pairedExecution.handleFrame(frame);
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
		lastSocketClient = next;
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

	try {
		await connectOnce();
	} catch (err) {
		if (!retryInitialConnect) {
			throw err;
		}
		log(
			'warn',
			`dashboard runtime daemon initial connect failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		void reconnectLoop();
	}

	return {
		snapshot(): RuntimeDaemonSnapshot {
			const executionSnapshot = pairedExecution.snapshot();
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
				activeRuns: executionSnapshot.activeRuns,
				completedRuns: executionSnapshot.completedRuns,
				...(currentInstanceId ? {instanceId: currentInstanceId} : {}),
				...(currentDashboardUrl ? {dashboardUrl: currentDashboardUrl} : {}),
				...(refreshState ? {refreshState} : {}),
			};
		},
		listRuns(opts = {}): RuntimeDaemonRunRecord[] {
			return pairedExecution.listRuns(opts);
		},
		async stop(reason = 'stopped') {
			stopped = true;
			clearRefreshTimer();
			clearFeedDrainTimer();
			const current = client;
			client = null;
			current?.close(reason);
			await pairedExecution.stop();
		},
	};
}
