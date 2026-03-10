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

const HookContext = createContext<HookContextValue | null>(null);
const RuntimeRefContext = createContext<Runtime | null>(null);
const EMPTY_MESSAGES: never[] = [];
const MISSING_CONTEXT = Symbol('missing-hook-context');

function HookProviderContent({
	runtime,
	allowedTools,
	sessionStore,
	children,
}: {
	runtime: ReturnType<typeof createRuntime>;
	allowedTools?: string[];
	sessionStore: ReturnType<typeof createSessionStore>;
	children: HookProviderProps['children'];
}) {
	const hookServer = useFeed(
		runtime,
		EMPTY_MESSAGES,
		allowedTools,
		sessionStore,
		{autoStart: false},
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

	useEffect(() => {
		return () => {
			sessionStore.close();
			runtime.stop();
		};
	}, [runtime, sessionStore]);

	if (readyRuntime !== runtime) {
		return <Text dimColor>Starting Athena hook server...</Text>;
	}

	return (
		<RuntimeRefContext.Provider value={runtime}>
			<HookProviderContent
				runtime={runtime}
				allowedTools={allowedTools}
				sessionStore={sessionStore}
			>
				{children}
			</HookProviderContent>
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
