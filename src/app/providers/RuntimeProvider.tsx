import {useEffect, useMemo, useState} from 'react';
import {Text} from 'ink';
import {
	createContext,
	useContext,
	useContextSelector,
} from 'use-context-selector';
import path from 'node:path';
import {useFeed} from './useFeed';
import {createSessionStore} from '../../infra/sessions/store';
import {sessionsDir} from '../../infra/sessions/registry';
import {type HookContextValue, type HookProviderProps} from './types';
import {createRuntime} from '../runtime/createRuntime';
import type {Runtime} from '../../core/runtime/types';
import type {SessionStore} from '../../infra/sessions/store';
import {SessionBridge} from '../channels/sessionBridge';
import type {RuntimeEvent, RuntimeDecision} from '../../core/runtime/types';
import {writeGatewayTrace} from '../../infra/gatewayTrace';
const HookContext = createContext<HookContextValue | null>(null);
const RuntimeRefContext = createContext<Runtime | null>(null);
const SessionStoreContext = createContext<SessionStore | null>(null);
const SessionBridgeContext = createContext<SessionBridge | null>(null);
const EMPTY_MESSAGES: never[] = [];
const MISSING_CONTEXT = Symbol('missing-hook-context');
const SESSION_BRIDGE_RETRY_MS = 2_000;

function HookProviderContent({
	runtime,
	allowedTools,
	sessionStore,
	sessionBridge,
	children,
}: {
	runtime: ReturnType<typeof createRuntime>;
	allowedTools?: string[];
	sessionStore: ReturnType<typeof createSessionStore>;
	sessionBridge: SessionBridge | null;
	children: HookProviderProps['children'];
}) {
	const relayPermission = useMemo(() => {
		if (!sessionBridge) return undefined;
		return (event: RuntimeEvent) => {
			writeGatewayTrace(
				`RuntimeProvider relayPermission event=${event.id} tool=${resolveToolName(event)}`,
			);
			void sessionBridge
				.relayPermission({
					toolName: resolveToolName(event),
					description:
						event.display?.title ?? `${resolveToolName(event)} request`,
					inputPreview: previewToolInput(event),
					...(event.interaction.defaultTimeoutMs !== undefined
						? {ttlMs: event.interaction.defaultTimeoutMs}
						: {}),
				})
				.then(res => {
					const decision = permissionRelayDecision(res.result);
					if (!decision) return;
					runtime.sendDecision(event.id, decision);
				})
				.catch(err => {
					if (process.env['ATHENA_GATEWAY_TRACE'] === '1') {
						console.error(
							`[athena] gateway relayPermission failed: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				});
		};
	}, [runtime, sessionBridge]);

	const hookServer = useFeed(
		runtime,
		EMPTY_MESSAGES,
		allowedTools,
		sessionStore,
		{autoStart: false, ...(relayPermission ? {relayPermission} : {})},
	);

	return (
		<HookContext.Provider value={hookServer}>{children}</HookContext.Provider>
	);
}

export function HookProvider({
	projectDir,
	instanceId,
	harness,
	workflow,
	runtime: providedRuntime,
	runtimeFactory = createRuntime,
	allowedTools,
	athenaSessionId,
	children,
}: HookProviderProps) {
	// Runtime must be stable (memoized) — useFeed assumes it doesn't change
	const runtime = useMemo(
		() =>
			providedRuntime ??
			runtimeFactory({
				harness,
				projectDir,
				instanceId,
				...(workflow ? {workflow} : {}),
			}),
		[
			providedRuntime,
			runtimeFactory,
			harness,
			projectDir,
			instanceId,
			workflow,
		],
	);

	const sessionStore = useMemo(
		() =>
			createSessionStore({
				sessionId: athenaSessionId,
				projectDir,
				dbPath: path.join(sessionsDir(), athenaSessionId, 'session.db'),
			}),
		[athenaSessionId, projectDir],
	);

	const [readyRuntime, setReadyRuntime] = useState<Runtime | null>(null);
	const [sessionBridge, setSessionBridge] = useState<SessionBridge | null>(
		null,
	);

	useEffect(() => {
		let cancelled = false;
		setReadyRuntime(null);
		void runtime.start().finally(() => {
			if (!cancelled) {
				setReadyRuntime(runtime);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [runtime]);

	// Best-effort gateway connection. Falls through silently when the daemon
	// isn't running so dev/test sessions still work without a gateway.
	useEffect(() => {
		let cancelled = false;
		let retryTimer: NodeJS.Timeout | null = null;
		let activeBridge: SessionBridge | null = null;
		const connectBridge = () => {
			const bridge = new SessionBridge({
				runtimeId: athenaSessionId,
				defaultAgentId: 'main',
			});
			writeGatewayTrace(
				`RuntimeProvider starting SessionBridge runtimeId=${athenaSessionId}`,
			);
			bridge
				.start()
				.then(() => {
					if (cancelled) {
						void bridge.stop();
						return;
					}
					activeBridge = bridge;
					writeGatewayTrace(
						`RuntimeProvider SessionBridge ready runtimeId=${athenaSessionId}`,
					);
					setSessionBridge(bridge);
				})
				.catch(err => {
					writeGatewayTrace(
						`RuntimeProvider SessionBridge failed runtimeId=${athenaSessionId} error=${
							err instanceof Error ? err.message : String(err)
						}`,
					);
					if (!cancelled) {
						retryTimer = setTimeout(connectBridge, SESSION_BRIDGE_RETRY_MS);
					}
				});
		};
		connectBridge();
		return () => {
			cancelled = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
			}
			void activeBridge?.stop();
			setSessionBridge(null);
		};
	}, [athenaSessionId]);

	// Separate lifecycle effects: closing sessionStore must only happen when
	// sessionStore itself is recreated (or on unmount), NOT when runtime changes.
	// Previously these were combined, so a workflow change (which recreates
	// runtime but not sessionStore) would close the still-active database.
	useEffect(() => {
		return () => {
			sessionStore.close();
		};
	}, [sessionStore]);

	useEffect(() => {
		return () => {
			runtime.stop();
		};
	}, [runtime]);

	if (readyRuntime !== runtime) {
		return <Text dimColor>Starting Athena hook server...</Text>;
	}

	return (
		<RuntimeRefContext.Provider value={runtime}>
			<SessionStoreContext.Provider value={sessionStore}>
				<SessionBridgeContext.Provider value={sessionBridge}>
					<HookProviderContent
						runtime={runtime}
						allowedTools={allowedTools}
						sessionStore={sessionStore}
						sessionBridge={sessionBridge}
					>
						{children}
					</HookProviderContent>
				</SessionBridgeContext.Provider>
			</SessionStoreContext.Provider>
		</RuntimeRefContext.Provider>
	);
}

export function useHookContext(): HookContextValue {
	const context = useContext(HookContext);
	if (!context) {
		throw new Error('useHookContext must be used within a HookProvider');
	}
	return context;
}

export function useHookContextSelector<T>(
	selector: (value: HookContextValue) => T,
): T {
	const selected = useContextSelector(HookContext, value =>
		value === null ? MISSING_CONTEXT : selector(value),
	);
	if (selected === MISSING_CONTEXT) {
		throw new Error(
			'useHookContextSelector must be used within a HookProvider',
		);
	}
	return selected as T;
}

// Optional hook that doesn't throw if used outside provider
export function useOptionalHookContext(): HookContextValue | null {
	return useContext(HookContext);
}

/**
 * Access the Runtime instance created by HookProvider.
 *
 * Harness-specific session hooks use this to project the shared runtime into
 * shell-facing state and prompt execution helpers.
 */
export function useRuntime(): Runtime | null {
	return useContext(RuntimeRefContext);
}

export function useSessionStore(): SessionStore | null {
	return useContext(SessionStoreContext);
}

/**
 * Access the SessionBridge for the current session. Returns `null` when the
 * gateway daemon is unreachable or while the bridge is still connecting. Code
 * that depends on the bridge must handle the null case (channel-driven flows
 * are inactive in that state).
 */
export function useSessionBridge(): SessionBridge | null {
	return useContext(SessionBridgeContext);
}

function resolveToolName(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown>;
	return (
		event.toolName ??
		(typeof data['tool_name'] === 'string' ? data['tool_name'] : undefined) ??
		'Tool'
	);
}

function previewToolInput(event: RuntimeEvent): string {
	const data = event.data as Record<string, unknown>;
	const input = data['tool_input'] ?? event.payload;
	if (typeof input === 'string') return input.slice(0, 4_000);
	try {
		return JSON.stringify(input, null, 2).slice(0, 4_000);
	} catch {
		return String(input).slice(0, 4_000);
	}
}

function permissionRelayDecision(
	result: Awaited<ReturnType<SessionBridge['relayPermission']>>['result'],
): RuntimeDecision | null {
	if (result.kind !== 'verdict') return null;
	if (result.behavior === 'allow') {
		return {
			type: 'json',
			source: 'user',
			intent: {kind: 'permission_allow'},
		};
	}
	return {
		type: 'json',
		source: 'user',
		intent: {
			kind: 'permission_deny',
			reason: `Denied by ${result.channelId}`,
		},
	};
}
