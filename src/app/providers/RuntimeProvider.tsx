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
import {
	createRelayPermissionCallback,
	createRelayQuestionCallback,
} from '../channels/relayAdapter';
import {startSessionBridge} from '../channels/sessionBridgeLifecycle';

const HookContext = createContext<HookContextValue | null>(null);
const RuntimeRefContext = createContext<Runtime | null>(null);
const SessionStoreContext = createContext<SessionStore | null>(null);
const SessionBridgeContext = createContext<SessionBridge | null>(null);
const EMPTY_MESSAGES: never[] = [];
const MISSING_CONTEXT = Symbol('missing-hook-context');

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
	const relayPermission = useMemo(
		() =>
			sessionBridge
				? createRelayPermissionCallback(sessionBridge, runtime)
				: undefined,
		[runtime, sessionBridge],
	);
	const relayQuestion = useMemo(
		() =>
			sessionBridge
				? createRelayQuestionCallback(sessionBridge, runtime)
				: undefined,
		[runtime, sessionBridge],
	);

	const hookServer = useFeed(
		runtime,
		EMPTY_MESSAGES,
		allowedTools,
		sessionStore,
		{
			...(relayPermission ? {relayPermission} : {}),
			...(relayQuestion ? {relayQuestion} : {}),
		},
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
	attachmentId,
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
		const controller = new AbortController();
		void startSessionBridge({
			runtimeId: athenaSessionId,
			defaultAgentId: 'main',
			...(attachmentId !== undefined ? {attachmentId} : {}),
			signal: controller.signal,
		}).then(bridge => {
			if (!bridge) return;
			if (controller.signal.aborted) {
				void bridge.stop();
				return;
			}
			setSessionBridge(bridge);
		});
		return () => {
			controller.abort();
			setSessionBridge(prev => {
				void prev?.stop();
				return null;
			});
		};
	}, [athenaSessionId, attachmentId]);

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
