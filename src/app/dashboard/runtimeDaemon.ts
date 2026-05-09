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

type RuntimeDaemonAssignmentExecutor = (
	input: ExecuteRemoteAssignmentInput,
) => Promise<void>;

export type RuntimeDaemonHandle = {
	stop(reason?: string): Promise<void>;
};

export type RunDashboardRuntimeDaemonOptions = {
	readConfig?: () => DashboardClientConfig | null;
	refreshAccessToken?: (label: 'daemon') => Promise<DashboardAccessToken>;
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
};

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
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

	let stopped = false;
	let reconnectAttempt = 0;
	let client: InstanceSocketClient | null = null;
	const active = new Map<
		string,
		{controller: AbortController; promise: Promise<void>}
	>();

	function nextReconnectDelay(): number {
		if (reconnectDelays.length === 0) return 0;
		const delayMs =
			reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ??
			0;
		reconnectAttempt += 1;
		return delayMs;
	}

	async function connectOnce(): Promise<void> {
		const config = readConfig();
		if (!config) {
			throw new Error(
				'dashboard runtime daemon: not paired. Run "drisp dashboard pair" first.',
			);
		}
		const token = await refreshAccessTokenFn('daemon');
		const next = makeClient({
			dashboardUrl: config.dashboardUrl,
			instanceId: token.instanceId,
			accessToken: token.accessToken,
			log,
		});
		next.onFrame(frame => {
			if (frame.type === 'cancel') {
				active.get(frame.runId)?.controller.abort();
				return;
			}
			if (frame.type !== 'job_assignment') return;
			if (active.has(frame.runId)) return;
			const controller = new AbortController();
			const promise = executor({
				frame,
				client: next,
				projectDir,
				log,
				abortSignal: controller.signal,
			})
				.catch(err => {
					log(
						'error',
						`run ${frame.runId} failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				})
				.finally(() => {
					active.delete(frame.runId);
				});
			active.set(frame.runId, {controller, promise});
		});
		next.onClose(reason => {
			if (stopped || client !== next) return;
			log('warn', `instance socket closed: ${reason}`);
			client = null;
			void reconnectLoop();
		});
		await next.connect();
		client = next;
		reconnectAttempt = 0;
		log('info', `dashboard runtime daemon connected as ${token.instanceId}`);
	}

	async function reconnectLoop(): Promise<void> {
		while (!stopped && client === null) {
			const waitMs = nextReconnectDelay();
			if (waitMs > 0) await delay(waitMs);
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
		async stop(reason = 'stopped') {
			stopped = true;
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
