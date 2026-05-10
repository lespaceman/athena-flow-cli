/**
 * Dispatch fork.
 *
 * AppShell receives every `session.dispatch.turn` push; the inbound text is
 * either chat input (treated as a user prompt fed to the harness) or a
 * runner envelope (handled by `runnerSession`). This helper makes the fork
 * decision in one place and falls through to chat when no runner envelope
 * is present.
 */
import type {SessionDispatchTurnPushPayload} from '../../shared/gateway-protocol';
import type {RunnerSession} from './runnerSession';

export type MakeDispatchRouterOptions = {
	runnerSession: RunnerSession | null;
	fallback: (payload: SessionDispatchTurnPushPayload) => void;
};

export function makeDispatchRouter(
	opts: MakeDispatchRouterOptions,
): (payload: SessionDispatchTurnPushPayload) => void {
	return payload => {
		if (opts.runnerSession) {
			const result = opts.runnerSession.handleDispatch({
				text: payload.inbound.text,
				dispatchId: payload.dispatchId,
				location: payload.inbound.location,
			});
			if (result.recognised) return;
		}
		opts.fallback(payload);
	};
}
