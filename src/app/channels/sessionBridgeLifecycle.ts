/**
 * Best-effort gateway-bridge connect-with-retry. Shared by the interactive
 * RuntimeProvider and the exec runner so both modes use the same connect
 * semantics.
 *
 * Caller is responsible for `bridge.stop()` on teardown.
 */

import {SessionBridge} from './sessionBridge';
import {writeGatewayTrace} from '../../infra/gatewayTrace';

const DEFAULT_RETRY_MS = 2_000;

export type StartSessionBridgeOptions = {
	runtimeId: string;
	defaultAgentId: string;
	/** See SessionBridgeOptions.attachmentId. */
	attachmentId?: string;
	signal?: AbortSignal;
	retryMs?: number;
};

/**
 * Resolves to a connected `SessionBridge`, or `null` if `signal` aborts
 * before the first successful connect. Transient errors (gateway daemon
 * unreachable) cause a delayed retry; the loop exits cleanly when the
 * caller aborts.
 */
export async function startSessionBridge(
	opts: StartSessionBridgeOptions,
): Promise<SessionBridge | null> {
	const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
	const signal = opts.signal;

	for (;;) {
		if (signal?.aborted) return null;

		const bridge = new SessionBridge({
			runtimeId: opts.runtimeId,
			defaultAgentId: opts.defaultAgentId,
			...(opts.attachmentId !== undefined
				? {attachmentId: opts.attachmentId}
				: {}),
		});
		writeGatewayTrace(`startSessionBridge attempt runtimeId=${opts.runtimeId}`);
		try {
			await bridge.start();
		} catch (err) {
			writeGatewayTrace(
				`startSessionBridge failed runtimeId=${opts.runtimeId} error=${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			if (signal?.aborted) return null;
			const aborted = await sleepOrAbort(retryMs, signal);
			if (aborted) return null;
			continue;
		}

		if (signal?.aborted) {
			void bridge.stop();
			return null;
		}
		writeGatewayTrace(`startSessionBridge ready runtimeId=${opts.runtimeId}`);
		return bridge;
	}
}

function sleepOrAbort(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	return new Promise(resolve => {
		if (signal?.aborted) {
			resolve(true);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve(false);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		signal?.addEventListener('abort', onAbort, {once: true});
	});
}
