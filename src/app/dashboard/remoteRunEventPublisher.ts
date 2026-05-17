import type {
	InstanceSocketClient,
	InstanceSocketLogger,
} from './instanceSocketClient';
import {
	createRunStreamClient,
	type RunStreamClient,
	type RunStreamClientOptions,
} from './runStreamClient';

export type RemoteRunEventPublisher = {
	publish(kind: string, payload: unknown, ts: number): void;
	close(): Promise<void>;
};

export type CreateRemoteRunEventPublisherOptions = {
	runId: string;
	callbackWsUrl?: string;
	callbackToken?: string;
	client: Pick<InstanceSocketClient, 'sendRunEvent'>;
	log?: InstanceSocketLogger;
	now?: () => number;
	createRunStreamClient?: (opts: RunStreamClientOptions) => RunStreamClient;
	runStreamConnectTimeoutMs?: number;
};

export async function createRemoteRunEventPublisher({
	runId,
	callbackWsUrl,
	callbackToken,
	client,
	log = () => {},
	now = Date.now,
	createRunStreamClient: createRunStreamClientFn = createRunStreamClient,
	runStreamConnectTimeoutMs = 5_000,
}: CreateRemoteRunEventPublisherOptions): Promise<RemoteRunEventPublisher> {
	let runStream: RunStreamClient | null = null;
	if (callbackWsUrl && callbackToken) {
		const candidate = createRunStreamClientFn({
			wsUrl: callbackWsUrl,
			token: callbackToken,
			log: (level, message) => log(level, `run-stream[${runId}]: ${message}`),
			now,
		});
		const timeoutPromise = new Promise<'timeout'>(resolve => {
			const timer = setTimeout(
				() => resolve('timeout'),
				runStreamConnectTimeoutMs,
			);
			timer.unref();
		});
		try {
			const result = await Promise.race([
				candidate.connect().then(() => 'connected' as const),
				timeoutPromise,
			]);
			if (result === 'connected') {
				runStream = candidate;
			} else {
				log(
					'warn',
					`run-stream[${runId}]: connect timed out after ${runStreamConnectTimeoutMs}ms; falling back to instance-socket relay`,
				);
				void candidate.close('connect_timeout');
			}
		} catch (err) {
			log(
				'warn',
				`run-stream[${runId}]: connect failed (${
					err instanceof Error ? err.message : String(err)
				}); falling back to instance-socket relay`,
			);
		}
	}

	let legacySeq = 0;
	return {
		publish(kind, payload, ts) {
			if (runStream) {
				runStream.sendEvent({ts, kind, payload});
				return;
			}
			legacySeq += 1;
			client.sendRunEvent({runId, seq: legacySeq, ts, kind, payload});
		},
		async close() {
			if (!runStream) return;
			const drainTimeout = new Promise<void>(resolve => {
				const timer = setTimeout(() => resolve(), 10_000);
				timer.unref();
			});
			await Promise.race([runStream.whenTerminated(), drainTimeout]);
			await runStream.close('done');
		},
	};
}
