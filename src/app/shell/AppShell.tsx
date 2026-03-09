import process from 'node:process';
import React, {
	Profiler,
	useState,
	useCallback,
	useRef,
	useEffect,
	useMemo,
} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import PermissionDialog from '../../ui/components/PermissionDialog';
import QuestionDialog from '../../ui/components/QuestionDialog';
import DiagnosticsConsentDialog, {
	type DiagnosticsConsentDecision,
} from '../../ui/components/DiagnosticsConsentDialog';
import ErrorBoundary from '../../ui/components/ErrorBoundary';
import {HookProvider} from '../providers/RuntimeProvider';
import {useHarnessProcess} from '../process/useHarnessProcess';
import {useHeaderMetrics} from '../../ui/hooks/useHeaderMetrics';
import {useTerminalTitle} from '../../ui/hooks/useTerminalTitle';
import {
	ShellInput,
	type ShellInputHandle,
} from '../../ui/components/ShellInput';
import {useAppMode} from '../../ui/hooks/useAppMode';
import {
	type InputHistory,
	useInputHistory,
} from '../../ui/hooks/useInputHistory';
import {useTodoPanel} from '../../ui/hooks/useTodoPanel';
import {useFeedKeyboard} from '../../ui/hooks/useFeedKeyboard';
import {useTodoKeyboard} from '../../ui/hooks/useTodoKeyboard';
import {useSpinner} from '../../ui/hooks/useSpinner';
import {useTodoDisplayItems} from '../../ui/hooks/useTodoDisplayItems';
import {useTimeline} from '../../ui/hooks/useTimeline';
import {useLayout} from '../../ui/hooks/useLayout';
import {usePager} from '../../ui/hooks/usePager';
import {useFrameChrome} from '../../ui/hooks/useFrameChrome';
import {
	buildBodyLines,
	buildTodoHeaderLine,
} from '../../ui/layout/buildBodyLines';
import {FeedGrid} from '../../ui/components/FeedGrid';
import {resolveFeedBackend} from '../../ui/components/FeedSurface';
import {useFeedColumns} from '../../ui/hooks/useFeedColumns';
import {buildHeaderModel} from '../../ui/header/model';
import {renderHeaderLines} from '../../ui/header/renderLines';
import type {Message as MessageType} from '../../shared/types/common';
import {generateId} from '../../shared/utils/id';
import type {SessionMetrics} from '../../shared/types/headerMetrics';
import type {
	IsolationConfig,
	IsolationPreset,
} from '../../harnesses/claude/config/isolation';
import {type PermissionDecision} from '../../core/controller/permission';
import {parseInput} from '../commands/parser';
import {executeCommand} from '../commands/executor';
import {
	ThemeProvider,
	useTheme,
	type Theme,
	resolveTheme,
} from '../../ui/theme/index';
import SessionPicker from '../../ui/components/SessionPicker';
import type {SessionEntry} from '../../shared/types/session';
import {
	type AthenaHarness,
	writeGlobalConfig,
} from '../../infra/plugins/config';
import {listSessions, getSessionMeta} from '../../infra/sessions/registry';
import chalk from 'chalk';
import {fit} from '../../shared/utils/format';
import {copyToClipboard} from '../../shared/utils/clipboard';
import {extractYankContent} from '../../ui/utils/yankContent';
import {detectHarness} from '../../shared/utils/detectHarness';
import type {WorkflowConfig} from '../../core/workflows/types';
import SetupWizard from '../../setup/SetupWizard';
import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {useRuntimeSelectors} from './useRuntimeSelectors';
import {useSessionScope, useTimelineCurrentRun} from './useSessionScope';
import {useShellInput} from './useShellInput';
import {useInputLayout} from './useInputLayout';
import {useGlobalKeyboard} from './useGlobalKeyboard';
import {
	initialSessionUiState,
	reduceSessionUiState,
	resolveSessionUiState,
	type SessionUiAction,
	type SessionUiContext,
} from './sessionUiState';
import {
	isPerfEnabled,
	logPerfEvent,
	logReactCommit,
	startEventLoopMonitor,
} from '../../shared/utils/perf';
import {
	isTelemetryEnabled,
	trackClaudeStartupFailed,
	trackSessionStarted,
	trackSessionEnded,
} from '../../infra/telemetry/index';
import {
	accumulateSessionTelemetryCarry,
	buildSessionTelemetrySummary,
	createEmptySessionTelemetryCarry,
} from './sessionTelemetry';

type Props = {
	projectDir: string;
	instanceId: number;
	harness: AthenaHarness;
	isolation?: IsolationConfig;
	verbose?: boolean;
	version: string;
	pluginMcpConfig?: string;
	modelName: string | null;
	theme: Theme;
	initialSessionId?: string;
	showSessionPicker?: boolean;
	workflowRef?: string;
	workflow?: WorkflowConfig;
	pluginFlags?: string[];
	isolationPreset: IsolationPreset;
	ascii?: boolean;
	showSetup?: boolean;
	athenaSessionId: string;
	initialTelemetryDiagnosticsConsent?: boolean;
};

type AppPhase =
	| {type: 'setup'}
	| {type: 'session-select'}
	| {type: 'main'; initialSessionId?: string};

const EMPTY_SESSION_METRICS: SessionMetrics = {
	modelName: null,
	toolCallCount: 0,
	totalToolCallCount: 0,
	subagentCount: 0,
	subagentMetrics: [],
	permissions: {
		allowed: 0,
		denied: 0,
	},
	sessionStartTime: null,
	tokens: {
		input: null,
		output: null,
		cacheRead: null,
		cacheWrite: null,
		total: null,
		contextSize: null,
	},
	failures: 0,
	blocks: 0,
};

function PermissionErrorFallback({onDeny}: {onDeny: () => void}) {
	const theme = useTheme();
	useInput((_input, key) => {
		if (key.escape) onDeny();
	});
	return (
		<Text color={theme.status.error}>
			[Permission dialog error -- press Escape to deny and continue]
		</Text>
	);
}

function QuestionErrorFallback({onSkip}: {onSkip: () => void}) {
	const theme = useTheme();
	useInput((_input, key) => {
		if (key.escape) onSkip();
	});
	return (
		<Text color={theme.status.error}>
			[Question dialog error -- press Escape to skip and continue]
		</Text>
	);
}

function DiagnosticsConsentErrorFallback({onDismiss}: {onDismiss: () => void}) {
	const theme = useTheme();
	useInput((_input, key) => {
		if (key.escape) onDismiss();
	});
	return (
		<Text color={theme.status.error}>
			[Diagnostics consent dialog error -- press Escape to dismiss]
		</Text>
	);
}

type PendingStartupDiagnosticsEvent = {
	failureStage: 'spawn_error' | 'exit_nonzero';
	message: string;
	exitCode?: number;
};

type StartupAttemptState = {
	feedEventCountAtSpawn: number;
};

function AppContent({
	projectDir,
	instanceId,
	harness,
	isolation,
	verbose,
	pluginMcpConfig,
	modelName,
	athenaSessionId,
	initialSessionId,
	onClear,
	onShowSessions,
	onShowSetup,
	inputHistory,
	sessionTelemetryMetricsRef,
	onSessionTelemetrySnapshot,
	initialTelemetryDiagnosticsConsent,
	workflowRef,
	workflow,
	ascii,
}: Omit<
	Props,
	| 'showSessionPicker'
	| 'showSetup'
	| 'theme'
	| 'pluginFlags'
	| 'isolationPreset'
	| 'version'
> & {
	initialSessionId?: string;
	onClear: () => void;
	onShowSessions: () => void;
	onShowSetup: () => void;
	inputHistory: InputHistory;
	sessionTelemetryMetricsRef: React.MutableRefObject<SessionMetrics>;
	onSessionTelemetrySnapshot: (metrics: SessionMetrics) => void;
	initialTelemetryDiagnosticsConsent?: boolean;
}) {
	const [messages, setMessages] = useState<MessageType[]>([]);
	const [uiState, setUiState] = useState(initialSessionUiState);
	const [toastMessage, setToastMessage] = useState<string | null>(null);
	const [diagnosticsConsent, setDiagnosticsConsent] = useState<
		boolean | undefined
	>(initialTelemetryDiagnosticsConsent);
	const [pendingStartupDiagnostics, setPendingStartupDiagnostics] =
		useState<PendingStartupDiagnosticsEvent | null>(null);
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const startupAttemptRef = useRef<StartupAttemptState | null>(null);
	const inputMode = uiState.inputMode;
	const hintsForced = uiState.hintsForced;
	const showRunOverlay = uiState.showRunOverlay;
	const searchQuery = uiState.searchQuery;
	const perfEnabled = isPerfEnabled();
	usePerfRenderLog(perfEnabled, 'app.main.content.render');
	const handleSectionProfilerRender = useCallback(
		(
			id: string,
			phaseName: string,
			actualDuration: number,
			baseDuration: number,
			startTime: number,
			commitTime: number,
		) => {
			logReactCommit(
				id,
				phaseName,
				actualDuration,
				baseDuration,
				startTime,
				commitTime,
			);
		},
		[],
	);

	const theme = useTheme();
	const {
		feedEvents,
		feedItems,
		tasks,
		session,
		currentRun,
		currentPermissionRequest,
		permissionQueueCount,
		resolvePermission,
		currentQuestionRequest,
		questionQueueCount,
		resolveQuestion,
		postByToolUseId,
		allocateSeq,
		clearEvents,
		emitNotification,
		recordTokens,
		restoredTokens,
		hookCommandFeed,
	} = useRuntimeSelectors();

	const currentSessionId = session?.session_id ?? null;
	const sessionScope = useSessionScope(athenaSessionId, currentSessionId);
	const timelineCurrentRun = useTimelineCurrentRun(currentRun);
	const harnessLabel = detectHarness(harness);

	const onExitTokens = useCallback(
		(tokens: import('../../shared/types/headerMetrics').TokenUsage) => {
			if (session?.session_id) {
				recordTokens(session.session_id, tokens);
			}
		},
		[session?.session_id, recordTokens],
	);

	const emitClaudeStartupDiagnostics = useCallback(
		(event: PendingStartupDiagnosticsEvent) => {
			trackClaudeStartupFailed({
				harness,
				failureStage: event.failureStage,
				message: event.message,
				exitCode: event.exitCode,
			});
		},
		[harness],
	);

	const onProcessLifecycleEvent = useCallback(
		(
			event: import('../../core/runtime/process').HarnessProcessLifecycleEvent,
		) => {
			const startupAttempt = startupAttemptRef.current;
			const isStartupFailure =
				harness === 'claude-code' && startupAttempt !== null;

			if (event.type === 'spawn_error') {
				emitNotification(
					`Athena failed to start ${harnessLabel}: ${event.message}`,
					`${harnessLabel} Process Error`,
				);

				if (isStartupFailure && isTelemetryEnabled()) {
					const diagnosticsEvent: PendingStartupDiagnosticsEvent = {
						failureStage: 'spawn_error',
						message: event.message,
					};
					if (diagnosticsConsent === true) {
						emitClaudeStartupDiagnostics(diagnosticsEvent);
					} else if (diagnosticsConsent === undefined) {
						setPendingStartupDiagnostics(diagnosticsEvent);
					}
				}
				startupAttemptRef.current = null;
				return;
			}

			emitNotification(
				`Athena lost the ${harnessLabel} process: ${event.message}`,
				`${harnessLabel} Process Error`,
			);

			if (isStartupFailure && isTelemetryEnabled()) {
				const diagnosticsEvent: PendingStartupDiagnosticsEvent = {
					failureStage: 'exit_nonzero',
					message: event.message,
					exitCode: event.code,
				};
				if (diagnosticsConsent === true) {
					emitClaudeStartupDiagnostics(diagnosticsEvent);
				} else if (diagnosticsConsent === undefined) {
					setPendingStartupDiagnostics(diagnosticsEvent);
				}
			}
			startupAttemptRef.current = null;
		},
		[
			diagnosticsConsent,
			emitClaudeStartupDiagnostics,
			emitNotification,
			harness,
			harnessLabel,
		],
	);

	const {
		spawn: spawnHarness,
		isRunning: isHarnessRunning,
		interrupt,
		tokenUsage,
	} = useHarnessProcess({
		harness,
		projectDir,
		instanceId,
		isolation,
		pluginMcpConfig,
		verbose,
		workflow,
		options: {
			initialTokens: restoredTokens,
			onExitTokens,
			onLifecycleEvent: onProcessLifecycleEvent,
			trackOutput: false,
			trackStreamingText: false,
			tokenUpdateMs: 1000,
		},
	});
	const {exit} = useApp();
	const {stdout} = useStdout();
	const terminalWidth = stdout.columns;
	const terminalRows = stdout.rows;
	// Reserve 1 column to prevent terminal auto-wrap: writing the last column
	// causes many terminals to move the cursor to the next line, consuming an
	// extra row and breaking the layout.
	const safeTerminalWidth = Math.max(4, terminalWidth - 1);

	// Hold initialSessionId as intent — consumed on first user prompt submission.
	// Deferred spawn: no Claude process runs until user provides real input.
	const initialSessionRef = useRef(initialSessionId);

	const metrics = useHeaderMetrics(feedEvents);
	sessionTelemetryMetricsRef.current = metrics;

	useTerminalTitle(feedEvents, isHarnessRunning);
	const appMode = useAppMode(
		isHarnessRunning,
		currentPermissionRequest,
		currentQuestionRequest,
	);
	const diagnosticsDialogActive = pendingStartupDiagnostics !== null;
	const dialogActive =
		diagnosticsDialogActive ||
		appMode.type === 'permission' ||
		appMode.type === 'question';
	const activeDialogType = diagnosticsDialogActive
		? 'diagnostics'
		: appMode.type;

	useEffect(() => {
		const startupAttempt = startupAttemptRef.current;
		if (!startupAttempt) return;
		if (feedEvents.length <= startupAttempt.feedEventCountAtSpawn) return;
		startupAttemptRef.current = null;
	}, [feedEvents.length]);

	const addMessage = useCallback(
		(role: 'user' | 'assistant', content: string) => {
			const newMessage: MessageType = {
				id: generateId(),
				role,
				content,
				timestamp: new Date(),
				seq: allocateSeq(),
			};
			setMessages(prev => [...prev, newMessage]);
			return newMessage;
		},
		[allocateSeq],
	);

	const clearScreen = useCallback(() => {
		onSessionTelemetrySnapshot(metrics);
		clearEvents();
		process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
		onClear();
	}, [clearEvents, metrics, onClear, onSessionTelemetrySnapshot]);

	const timeline = useTimeline({
		feedItems,
		feedEvents,
		currentRun: timelineCurrentRun,
		searchQuery,
		postByToolUseId,
		verbose,
	});
	const {runSummaries, filteredEntries, searchMatches, searchMatchSet} =
		timeline;

	const todoPanel = useTodoPanel({
		tasks,
		isWorking: appMode.type === 'working',
		todoVisible: uiState.todoVisible,
		todoShowDone: uiState.todoShowDone,
		todoCursor: uiState.todoCursor,
		todoScroll: uiState.todoScroll,
		setTodoVisible: value =>
			setUiState(prev =>
				reduceSessionUiState(
					prev,
					{
						type: 'set_todo_visible',
						visible:
							typeof value === 'function' ? value(prev.todoVisible) : value,
					},
					uiContextRef.current,
				),
			),
		setTodoShowDone: value =>
			setUiState(prev =>
				reduceSessionUiState(
					prev,
					{
						type: 'set_todo_show_done',
						showDone:
							typeof value === 'function' ? value(prev.todoShowDone) : value,
					},
					uiContextRef.current,
				),
			),
		setTodoCursor: value =>
			setUiState(prev =>
				reduceSessionUiState(
					prev,
					{
						type: 'set_todo_cursor',
						cursor:
							typeof value === 'function' ? value(prev.todoCursor) : value,
					},
					uiContextRef.current,
				),
			),
		setTodoScroll: value =>
			setUiState(prev => ({
				...prev,
				todoScroll:
					typeof value === 'function' ? value(prev.todoScroll) : value,
			})),
	});

	const frameWidth = safeTerminalWidth;
	const innerWidth = frameWidth - 2;

	const filteredEntriesRef = useRef(filteredEntries);
	filteredEntriesRef.current = filteredEntries;
	const uiContextRef = useRef<SessionUiContext>({
		feedEntryCount: 0,
		feedContentRows: 1,
		searchMatchCount: 0,
		todoVisibleCount: 0,
		todoListHeight: 0,
		todoFocusable: false,
		todoAnchorIndex: -1,
		staticFloor: 0,
	});
	const dispatchUi = useCallback((action: SessionUiAction) => {
		setUiState(prev =>
			reduceSessionUiState(prev, action, uiContextRef.current),
		);
	}, []);

	const submitPromptOrSlashCommand = useCallback(
		(value: string) => {
			if (!value.trim()) return;
			inputHistory.push(value);
			const result = parseInput(value);
			if (result.type === 'prompt') {
				addMessage('user', result.text);
				const sessionToResume = currentSessionId ?? initialSessionRef.current;
				startupAttemptRef.current = {
					feedEventCountAtSpawn: feedEvents.length,
				};
				spawnHarness(result.text, sessionToResume ?? undefined).catch(
					(err: unknown) => {
						startupAttemptRef.current = null;
						console.error('[athena] spawn failed:', err);
					},
				);
				// Clear intent after first use — subsequent prompts use currentSessionId from mapper
				if (initialSessionRef.current) {
					initialSessionRef.current = undefined;
				}
				return;
			}
			addMessage('user', value);
			const addMessageObj = (msg: Omit<MessageType, 'seq'>) =>
				setMessages(prev => [...prev, {...msg, seq: allocateSeq()}]);
			const elapsed = metrics.sessionStartTime
				? Math.floor((Date.now() - metrics.sessionStartTime.getTime()) / 1000)
				: 0;
			executeCommand(result.command, result.args, {
				ui: {
					args: result.args,
					get messages() {
						return messagesRef.current;
					},
					setMessages,
					addMessage: addMessageObj,
					exit,
					clearScreen,
					showSessions: onShowSessions,
					showSetup: onShowSetup,
					sessionStats: {
						metrics: {
							...metrics,
							modelName: metrics.modelName || modelName,
							tokens: tokenUsage,
						},
						tokens: tokenUsage,
						elapsed,
					},
				},
				hook: {args: result.args, feed: hookCommandFeed},
				prompt: {
					spawn: (prompt, sessionId, configOverride) => {
						startupAttemptRef.current = {
							feedEventCountAtSpawn: feedEvents.length,
						};
						return spawnHarness(prompt, sessionId, configOverride).catch(
							(err: unknown) => {
								startupAttemptRef.current = null;
								throw err;
							},
						);
					},
					currentSessionId: currentSessionId ?? undefined,
				},
			}).catch((err: unknown) => {
				console.error('[athena] command execution failed:', err);
			});
		},
		[
			inputHistory,
			addMessage,
			allocateSeq,
			feedEvents.length,
			spawnHarness,
			currentSessionId,
			exit,
			clearScreen,
			onShowSessions,
			onShowSetup,
			metrics,
			modelName,
			tokenUsage,
			hookCommandFeed,
		],
	);

	const getSelectedCommandRef = useRef<
		() => import('../commands/types').Command | undefined
	>(() => undefined);

	const {
		inputRows,
		inputValueRef,
		setInputValueRef,
		inputContentWidthRef,
		handleMainInputChange,
		handleInputSubmit,
		handleSetValueRef,
	} = useShellInput({
		inputMode,
		setInputMode: nextInputMode =>
			dispatchUi({type: 'set_input_mode', inputMode: nextInputMode}),
		setSearchQuery: query => dispatchUi({type: 'set_search_query', query}),
		closeInput: () => dispatchUi({type: 'cancel_input'}),
		submitSearchQuery: (query, firstMatchIndex) =>
			dispatchUi({type: 'submit_search_query', query, firstMatchIndex}),
		submitPromptOrSlashCommand,
		filteredEntriesRef,
		getSelectedCommand: () => getSelectedCommandRef.current(),
	});

	const shellInputRef = useRef<ShellInputHandle>(null);
	getSelectedCommandRef.current = () =>
		shellInputRef.current?.getSelectedCommand();

	const {back: handleHistoryBack, forward: handleHistoryForward} = inputHistory;

	const stableSetInputValue = useCallback(
		(v: string) => setInputValueRef.current(v),
		[setInputValueRef],
	);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const stableGetInputValue = useCallback(() => inputValueRef.current, []);
	// Footer row budget for layout: hints row + gap row + input base row.
	// buildFrameLines always produces non-null footerHelp when inputValue is
	// empty (the provisional case), so this is a compile-time constant.
	const provisionalFooterRows = 3;
	const layout = useLayout({
		terminalRows,
		terminalWidth: safeTerminalWidth,
		showRunOverlay,
		runSummaries,
		todoPanel,
		feedEntryCount: filteredEntries.length,
		footerRows: provisionalFooterRows,
		inputRows,
	});

	const {
		feedHeaderRows,
		feedContentRows,
		actualTodoRows,
		actualRunOverlayRows,
	} = layout;

	// ── Feed backend & feedStartRow ────────────────────────────────
	// Resolve once per render so all consumers agree on the backend.
	const feedBackend = resolveFeedBackend();
	// Rows above the feed region in Ink's render tree:
	//   3  = header frame (topBorder + headerLine + sectionBorder)
	//   +  actualTodoRows  (header line + body lines incl. divider)
	//   +  actualRunOverlayRows
	// feedStartRow is 1-based for ANSI cursor addressing.
	const feedStartRow = 3 + actualTodoRows + actualRunOverlayRows + 1;

	// FeedGrid subtracts 1 from feedContentRows for the header divider line.
	// The navigation viewport must match the actual visible data rows.
	const showFeedHeaderDivider = feedHeaderRows > 0 && feedContentRows > 1;
	const visibleFeedContentRows = Math.max(
		1,
		feedContentRows - (showFeedHeaderDivider ? 1 : 0),
	);
	const pageStep = Math.max(1, Math.floor(visibleFeedContentRows / 2));
	const uiContext = useMemo(
		(): SessionUiContext => ({
			feedEntryCount: filteredEntries.length,
			feedContentRows: visibleFeedContentRows,
			searchMatchCount: searchMatches.length,
			todoVisibleCount: todoPanel.visibleTodoItems.length,
			todoListHeight: layout.todoListHeight,
			todoFocusable:
				uiState.todoVisible && todoPanel.visibleTodoItems.length > 0,
			todoAnchorIndex: todoPanel.autoFocusIndex,
			staticFloor: 0,
		}),
		[
			filteredEntries.length,
			visibleFeedContentRows,
			searchMatches.length,
			layout.todoListHeight,
			uiState.todoVisible,
			todoPanel.visibleTodoItems.length,
			todoPanel.autoFocusIndex,
		],
	);
	uiContextRef.current = uiContext;
	const resolvedUiState = useMemo(
		() => resolveSessionUiState(uiState, uiContext),
		[uiState, uiContext],
	);
	const focusMode = resolvedUiState.focusMode;
	const searchMatchPos = resolvedUiState.searchMatchPos;
	const feedNav = {
		feedCursor: resolvedUiState.feedCursor,
		feedViewportStart: resolvedUiState.feedViewportStart,
		tailFollow: resolvedUiState.tailFollow,
		moveFeedCursor: (delta: number) =>
			dispatchUi({type: 'move_feed_cursor', delta}),
		jumpToTail: () => dispatchUi({type: 'jump_feed_tail'}),
		jumpToTop: () => dispatchUi({type: 'jump_feed_top'}),
		setFeedCursor: (cursor: number) =>
			dispatchUi({type: 'set_feed_cursor', cursor}),
		setTailFollow: (tailFollow: boolean) =>
			dispatchUi({type: 'set_tail_follow', tailFollow}),
	};
	const staticHighWaterMark = 0;

	const {
		frame,
		topBorder,
		bottomBorder,
		sectionBorder,
		frameLine,
		lastRunStatus,
		visibleSearchMatches,
	} = useFrameChrome({
		innerWidth,
		focusMode,
		inputMode,
		searchQuery,
		searchMatches,
		searchMatchPos,
		isHarnessRunning,
		dialogActive,
		dialogType: activeDialogType,
		hintsForced,
		ascii: !!ascii,
		accentColor: theme.inputPrompt,
		runSummaries,
		staticHighWaterMark,
	});
	const cycleFocus = useCallback(
		() => dispatchUi({type: 'cycle_focus'}),
		[dispatchUi],
	);

	const handlePermissionDecision = useCallback(
		(decision: PermissionDecision) => {
			if (!currentPermissionRequest) return;
			resolvePermission(currentPermissionRequest.request_id, decision);
		},
		[currentPermissionRequest, resolvePermission],
	);
	const handleQuestionAnswer = useCallback(
		(answers: Record<string, string>) => {
			if (!currentQuestionRequest?.cause?.hook_request_id) return;
			resolveQuestion(currentQuestionRequest.cause.hook_request_id, answers);
		},
		[currentQuestionRequest, resolveQuestion],
	);
	const handleQuestionSkip = useCallback(() => {
		if (!currentQuestionRequest?.cause?.hook_request_id) return;
		resolveQuestion(currentQuestionRequest.cause.hook_request_id, {});
	}, [currentQuestionRequest, resolveQuestion]);
	const handleDiagnosticsDecision = useCallback(
		(decision: DiagnosticsConsentDecision) => {
			const pending = pendingStartupDiagnostics;
			setPendingStartupDiagnostics(null);
			if (!pending) return;

			if (decision === 'send-once') {
				emitClaudeStartupDiagnostics(pending);
				return;
			}

			if (decision === 'always-send') {
				writeGlobalConfig({telemetryDiagnostics: true});
				setDiagnosticsConsent(true);
				emitClaudeStartupDiagnostics(pending);
				return;
			}

			writeGlobalConfig({telemetryDiagnostics: false});
			setDiagnosticsConsent(false);
		},
		[emitClaudeStartupDiagnostics, pendingStartupDiagnostics],
	);

	const {pagerActive, handleExpandForPager} = usePager({
		filteredEntriesRef,
		feedCursor: feedNav.feedCursor,
	});

	useGlobalKeyboard({
		isActive: !dialogActive && !pagerActive,
		isHarnessRunning,
		focusMode,
		dialogActive,
		callbacks: {
			interrupt,
			cycleFocus,
			cancelInput: () => dispatchUi({type: 'cancel_input'}),
			cycleHintsForced: () => dispatchUi({type: 'cycle_hints_forced'}),
			toggleTodoVisible: () => dispatchUi({type: 'toggle_todo_visible'}),
			historyBack: inputHistory.back,
			historyForward: inputHistory.forward,
			getInputValue: stableGetInputValue,
			setInputValue: stableSetInputValue,
			inputMode,
			commandSuggestions: {
				visible: () => shellInputRef.current?.showSuggestions ?? false,
				moveUp: () => shellInputRef.current?.moveUp(),
				moveDown: () => shellInputRef.current?.moveDown(),
				tab: () => {
					const cmd = shellInputRef.current?.getSelectedCommand();
					if (cmd) stableSetInputValue(`/${cmd.name} `);
				},
			},
		},
	});

	const showToast = useCallback((msg: string) => {
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		setToastMessage(msg);
		toastTimerRef.current = setTimeout(() => setToastMessage(null), 1500);
	}, []);

	useEffect(() => {
		return () => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		};
	}, []);

	const yankAtCursor = useCallback(() => {
		const entry = filteredEntriesRef.current.at(feedNav.feedCursor);
		if (!entry) return;
		const content = extractYankContent(entry);
		copyToClipboard(content);
		showToast('Copied to clipboard!');
	}, [feedNav.feedCursor, showToast]);

	useFeedKeyboard({
		isActive: focusMode === 'feed' && !dialogActive && !pagerActive,
		pageStep,
		searchMatches: visibleSearchMatches,
		callbacks: {
			moveFeedCursor: feedNav.moveFeedCursor,
			jumpToTail: feedNav.jumpToTail,
			jumpToTop: feedNav.jumpToTop,
			expandAtCursor: handleExpandForPager,
			yankAtCursor,
			cycleFocus,
			openCommandInput: () => dispatchUi({type: 'open_command_input'}),
			openSearchInput: () => dispatchUi({type: 'open_search_input'}),
			setInputValue: stableSetInputValue,
			hideRunOverlay: () =>
				dispatchUi({type: 'set_show_run_overlay', show: false}),
			stepSearchMatch: (direction, matches) =>
				dispatchUi({type: 'step_search_match', direction, matches}),
			clearSearchAndJumpTail: () =>
				dispatchUi({type: 'clear_search_and_jump_tail'}),
		},
	});

	useTodoKeyboard({
		isActive: focusMode === 'todo' && !dialogActive,
		todoCursor: resolvedUiState.todoCursor,
		visibleTodoItems: todoPanel.visibleTodoItems,
		filteredEntries,
		callbacks: {
			focusFeed: () => dispatchUi({type: 'set_focus_mode', focusMode: 'feed'}),
			openNormalInput: () => dispatchUi({type: 'open_normal_input'}),
			setInputValue: stableSetInputValue,
			moveTodoCursor: delta => dispatchUi({type: 'move_todo_cursor', delta}),
			revealFeedCursor: cursor =>
				dispatchUi({type: 'reveal_feed_entry', cursor}),
			toggleTodoStatus: todoPanel.toggleTodoStatus,
			cycleFocus,
		},
	});

	const hasColor = !process.env['NO_COLOR'];
	const useAscii = !!ascii;
	const todoColors = useMemo(
		() => ({
			doing: theme.status.warning,
			done: theme.textMuted,
			failed: theme.status.error,
			blocked: theme.status.warning,
			text: theme.text,
			textMuted: theme.textMuted,
			default: theme.status.neutral,
		}),
		[theme],
	);

	const sessionId = session?.session_id;
	const sessionAgentType = session?.agent_type;
	const headerLine1 = useMemo(() => {
		const headerModel = buildHeaderModel({
			session: session
				? {
						session_id: sessionId,
						agent_type: sessionAgentType,
					}
				: null,
			currentRun: timelineCurrentRun,
			runSummaries,
			metrics: {
				failures: metrics.failures,
				blocks: metrics.blocks,
			},
			todoPanel: {
				doneCount: todoPanel.doneCount,
				doingCount: todoPanel.doingCount,
				todoItems: {length: todoPanel.todoItems.length},
			},
			tailFollow: feedNav.tailFollow,
			now: 0,
			workflowRef,
			contextUsed: tokenUsage.contextSize,
			contextMax: 200000,
			sessionIndex: sessionScope.current,
			sessionTotal: sessionScope.total,
			harness,
		});
		return renderHeaderLines(headerModel, innerWidth, hasColor, theme)[0];
	}, [
		session,
		sessionId,
		sessionAgentType,
		timelineCurrentRun,
		runSummaries,
		metrics.failures,
		metrics.blocks,
		todoPanel.doneCount,
		todoPanel.doingCount,
		todoPanel.todoItems.length,
		feedNav.tailFollow,
		workflowRef,
		tokenUsage.contextSize,
		sessionScope,
		harness,
		innerWidth,
		hasColor,
		theme,
	]);

	const computedFeedCols = useFeedColumns(filteredEntries, innerWidth);
	const feedCols = computedFeedCols;

	const {inputPrefix, badgeText, inputContentWidth, textInputPlaceholder} =
		useInputLayout({
			innerWidth,
			inputMode,
			isHarnessRunning,
			lastRunStatus,
			dialogActive,
			dialogType: activeDialogType,
			ascii: useAscii,
		});
	inputContentWidthRef.current = inputContentWidth;
	const border = useMemo(() => chalk.hex(theme.border), [theme.border]);
	const inputKeywordColor = theme.inputPrompt;
	const inputChevronColor = theme.inputChevron;
	const inputPlaceholderColor = theme.textMuted;
	const inputPromptStyled = useMemo(
		() =>
			chalk.hex(inputKeywordColor).bold('input') +
			chalk.hex(inputChevronColor)('> '),
		[inputChevronColor, inputKeywordColor],
	);
	const runBadgeStyled = isHarnessRunning
		? chalk.bgHex('#4a3a0c').hex('#fbbf24')(' RUN ')
		: chalk.bgHex('#10321d').hex('#3fb950')(' IDLE ');
	let modeBadgeStyled = '';
	if (inputMode === 'search') {
		modeBadgeStyled = chalk.bgHex('#1b2a3f').hex(theme.accent)(' SEARCH ');
	} else if (inputMode === 'command') {
		modeBadgeStyled = chalk.bgHex('#2a1b3f').hex(theme.accent)(' CMD ');
	}
	const withBorderEdges = useCallback(
		(line: string): string => {
			if (line.length < 2) return line;
			const first = line.charAt(0);
			const last = line.charAt(line.length - 1);
			return `${border(first)}${line.slice(1, -1)}${border(last)}`;
		},
		[border],
	);

	// Stable callback for shell input suggestion rows — composes frameLine + border edges.
	const wrapFrameLine = useCallback(
		(line: string) => withBorderEdges(frameLine(line)),
		[withBorderEdges, frameLine],
	);
	if (pagerActive) {
		return <Box />;
	}

	return (
		<Box flexDirection="column" width={frameWidth}>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.header-frame"
				onRender={handleSectionProfilerRender}
			>
				<Text>{`${border(topBorder)}\n${withBorderEdges(frameLine(headerLine1))}\n${border(sectionBorder)}`}</Text>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.todo-header"
				onRender={handleSectionProfilerRender}
			>
				<TodoHeaderSection
					actualTodoRows={actualTodoRows}
					innerWidth={innerWidth}
					useAscii={useAscii}
					appModeType={appMode.type}
					todoColors={todoColors}
					doneCount={todoPanel.doneCount}
					totalCount={todoPanel.todoItems.length}
					theme={theme}
					withBorderEdges={withBorderEdges}
					frameLine={frameLine}
					spinnerActive={
						actualTodoRows > 0 &&
						appMode.type === 'working' &&
						focusMode === 'todo' &&
						todoPanel.todoVisible &&
						todoPanel.todoItems.length > 0 &&
						filteredEntries.length < 500
					}
				/>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.body-prefix"
				onRender={handleSectionProfilerRender}
			>
				<TodoBodySection
					innerWidth={innerWidth}
					actualTodoRows={actualTodoRows}
					todoScroll={resolvedUiState.todoScroll}
					todoCursor={resolvedUiState.todoCursor}
					visibleTodoItems={todoPanel.visibleTodoItems}
					focusMode={focusMode}
					useAscii={useAscii}
					todoColors={todoColors}
					appModeType={appMode.type}
					doneCount={todoPanel.doneCount}
					totalCount={todoPanel.todoItems.length}
					actualRunOverlayRows={actualRunOverlayRows}
					runSummaries={runSummaries}
					theme={theme}
					withBorderEdges={withBorderEdges}
					frameLine={frameLine}
					isWorking={appMode.type === 'working'}
					pausedAtMs={todoPanel.pausedAtMs}
					todoTickActive={false}
				/>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.feed"
				onRender={handleSectionProfilerRender}
			>
				<FeedGrid
					feedHeaderRows={feedHeaderRows}
					feedContentRows={feedContentRows}
					feedViewportStart={feedNav.feedViewportStart}
					filteredEntries={filteredEntries}
					feedCursor={feedNav.feedCursor}
					focusMode={focusMode}
					searchMatchSet={searchMatchSet}
					ascii={useAscii}
					theme={theme}
					innerWidth={innerWidth}
					cols={feedCols}
					feedStartRow={feedStartRow}
					backend={feedBackend}
				/>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.footer"
				onRender={handleSectionProfilerRender}
			>
				<FooterSection
					border={border}
					sectionBorder={sectionBorder}
					frameFooterHelp={frame.footerHelp}
					toastMessage={toastMessage}
					innerWidth={innerWidth}
					frameLine={frameLine}
					withBorderEdges={withBorderEdges}
				/>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.input"
				onRender={handleSectionProfilerRender}
			>
				<InputSection
					innerWidth={innerWidth}
					useAscii={useAscii}
					borderColor={theme.border}
					inputRows={inputRows}
					inputPrefix={inputPrefix}
					inputPromptStyled={inputPromptStyled}
					inputContentWidth={inputContentWidth}
					textInputPlaceholder={textInputPlaceholder}
					textColor={theme.text}
					inputPlaceholderColor={inputPlaceholderColor}
					isInputActive={focusMode === 'input' && !dialogActive}
					handleInputChange={handleMainInputChange}
					handleInputSubmit={handleInputSubmit}
					handleHistoryBack={handleHistoryBack}
					handleHistoryForward={handleHistoryForward}
					suppressArrows={inputMode === 'command'}
					handleSetValueRef={handleSetValueRef}
					commandSuggestionsEnabled={inputMode === 'command'}
					wrapSuggestionLine={wrapFrameLine}
					inputRef={shellInputRef}
					badgeText={badgeText}
					runBadgeStyled={runBadgeStyled}
					modeBadgeStyled={modeBadgeStyled}
					border={border}
					bottomBorder={bottomBorder}
				/>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.diagnostics-dialog"
				onRender={handleSectionProfilerRender}
			>
				<>
					{pendingStartupDiagnostics && (
						<ErrorBoundary
							fallback={
								<DiagnosticsConsentErrorFallback
									onDismiss={() => setPendingStartupDiagnostics(null)}
								/>
							}
						>
							<DiagnosticsConsentDialog
								harnessLabel={harnessLabel}
								onDecision={handleDiagnosticsDecision}
							/>
						</ErrorBoundary>
					)}
				</>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.permission-dialog"
				onRender={handleSectionProfilerRender}
			>
				<>
					{appMode.type === 'permission' && currentPermissionRequest && (
						<ErrorBoundary
							fallback={
								<PermissionErrorFallback
									onDeny={() => handlePermissionDecision('deny')}
								/>
							}
						>
							<PermissionDialog
								request={currentPermissionRequest}
								queuedCount={permissionQueueCount - 1}
								onDecision={handlePermissionDecision}
							/>
						</ErrorBoundary>
					)}
				</>
			</MaybeProfiler>
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.main.question-dialog"
				onRender={handleSectionProfilerRender}
			>
				<>
					{appMode.type === 'question' && currentQuestionRequest && (
						<ErrorBoundary
							fallback={<QuestionErrorFallback onSkip={handleQuestionSkip} />}
						>
							<QuestionDialog
								request={currentQuestionRequest}
								queuedCount={questionQueueCount - 1}
								onAnswer={handleQuestionAnswer}
								onSkip={handleQuestionSkip}
							/>
						</ErrorBoundary>
					)}
				</>
			</MaybeProfiler>
		</Box>
	);
}

function MaybeProfiler({
	enabled,
	id,
	onRender,
	children,
}: {
	enabled: boolean;
	id: string;
	onRender: React.ProfilerProps['onRender'];
	children: React.ReactNode;
}) {
	if (!enabled) return <>{children}</>;
	return (
		<Profiler id={id} onRender={onRender}>
			{children}
		</Profiler>
	);
}

const TodoHeaderSection = React.memo(function TodoHeaderSection({
	actualTodoRows,
	innerWidth,
	useAscii,
	appModeType,
	todoColors,
	doneCount,
	totalCount,
	theme,
	withBorderEdges,
	frameLine,
	spinnerActive,
}: {
	actualTodoRows: number;
	innerWidth: number;
	useAscii: boolean;
	appModeType: 'idle' | 'working' | 'permission' | 'question';
	todoColors: {
		doing: string;
		done: string;
		failed: string;
		blocked: string;
		text: string;
		textMuted: string;
		default: string;
	};
	doneCount: number;
	totalCount: number;
	theme: Theme;
	withBorderEdges: (line: string) => string;
	frameLine: (content: string) => string;
	spinnerActive: boolean;
}) {
	const spinnerFrame = useSpinner(spinnerActive);
	const todoHeaderLine = useMemo(
		() =>
			actualTodoRows > 0
				? buildTodoHeaderLine(
						innerWidth,
						{
							ascii: useAscii,
							appMode: appModeType,
							spinnerFrame,
							colors: todoColors,
							doneCount,
							totalCount,
						},
						theme,
					)
				: null,
		[
			actualTodoRows,
			innerWidth,
			useAscii,
			appModeType,
			spinnerFrame,
			todoColors,
			doneCount,
			totalCount,
			theme,
		],
	);

	return (
		<>
			{todoHeaderLine !== null && (
				<Text key="todo-header">
					{withBorderEdges(frameLine(todoHeaderLine))}
				</Text>
			)}
		</>
	);
});

const TodoBodySection = React.memo(function TodoBodySection({
	innerWidth,
	actualTodoRows,
	todoScroll,
	todoCursor,
	visibleTodoItems,
	focusMode,
	useAscii,
	todoColors,
	appModeType,
	doneCount,
	totalCount,
	actualRunOverlayRows,
	runSummaries,
	theme,
	withBorderEdges,
	frameLine,
	isWorking,
	pausedAtMs,
	todoTickActive,
}: {
	innerWidth: number;
	actualTodoRows: number;
	todoScroll: number;
	todoCursor: number;
	visibleTodoItems: import('../../core/feed/todoPanel').TodoPanelItem[];
	focusMode: string;
	useAscii: boolean;
	todoColors: {
		doing: string;
		done: string;
		failed: string;
		blocked: string;
		text: string;
		textMuted: string;
		default: string;
	};
	appModeType: 'idle' | 'working' | 'permission' | 'question';
	doneCount: number;
	totalCount: number;
	actualRunOverlayRows: number;
	runSummaries: import('../../core/feed/timeline').RunSummary[];
	theme: Theme;
	withBorderEdges: (line: string) => string;
	frameLine: (content: string) => string;
	isWorking: boolean;
	pausedAtMs: number | null;
	todoTickActive: boolean;
}) {
	const displayTodoItems = useTodoDisplayItems({
		items: visibleTodoItems,
		isWorking,
		pausedAtMs,
		active: todoTickActive,
	});
	const prefixBodyLines = useMemo(
		() =>
			buildBodyLines({
				innerWidth,
				todo: {
					actualTodoRows,
					todoPanel: {
						todoScroll,
						todoCursor,
						visibleTodoItems: displayTodoItems,
					},
					focusMode,
					ascii: useAscii,
					colors: todoColors,
					appMode: appModeType,
					doneCount,
					totalCount,
					spinnerFrame: '',
					skipHeader: true,
				},
				runOverlay: {actualRunOverlayRows, runSummaries, runFilter: 'all'},
				theme,
			}),
		[
			innerWidth,
			actualTodoRows,
			todoScroll,
			todoCursor,
			displayTodoItems,
			focusMode,
			useAscii,
			todoColors,
			appModeType,
			doneCount,
			totalCount,
			actualRunOverlayRows,
			runSummaries,
			theme,
		],
	);

	const output = useMemo(
		() =>
			prefixBodyLines.length > 0
				? prefixBodyLines
						.map(line => withBorderEdges(frameLine(line)))
						.join('\n')
				: null,
		[prefixBodyLines, withBorderEdges, frameLine],
	);

	if (output === null) return null;
	return <Text>{output}</Text>;
});

const FooterSection = React.memo(function FooterSection({
	border,
	sectionBorder,
	frameFooterHelp,
	toastMessage,
	innerWidth,
	frameLine,
	withBorderEdges,
}: {
	border: (text: string) => string;
	sectionBorder: string;
	frameFooterHelp: string | null;
	toastMessage: string | null;
	innerWidth: number;
	frameLine: (content: string) => string;
	withBorderEdges: (line: string) => string;
}) {
	const output = useMemo(() => {
		const lines = [border(sectionBorder)];
		if (frameFooterHelp !== null) {
			lines.push(
				withBorderEdges(
					frameLine(
						toastMessage
							? chalk.bold.green(toastMessage)
							: fit(frameFooterHelp, innerWidth),
					),
				),
			);
			lines.push(withBorderEdges(frameLine('')));
		}
		return lines.join('\n');
	}, [
		border,
		sectionBorder,
		frameFooterHelp,
		toastMessage,
		innerWidth,
		frameLine,
		withBorderEdges,
	]);

	return <Text>{output}</Text>;
});

const InputSection = React.memo(function InputSection({
	innerWidth,
	useAscii,
	borderColor,
	inputRows,
	inputPrefix,
	inputPromptStyled,
	inputContentWidth,
	textInputPlaceholder,
	textColor,
	inputPlaceholderColor,
	isInputActive,
	handleInputChange,
	handleInputSubmit,
	handleHistoryBack,
	handleHistoryForward,
	suppressArrows,
	handleSetValueRef,
	commandSuggestionsEnabled,
	wrapSuggestionLine,
	inputRef,
	badgeText,
	runBadgeStyled,
	modeBadgeStyled,
	border,
	bottomBorder,
}: {
	innerWidth: number;
	useAscii: boolean;
	borderColor: string;
	inputRows: number;
	inputPrefix: string;
	inputPromptStyled: string;
	inputContentWidth: number;
	textInputPlaceholder: string;
	textColor: string;
	inputPlaceholderColor: string;
	isInputActive: boolean;
	handleInputChange: (value: string) => void;
	handleInputSubmit: (value: string) => void;
	handleHistoryBack: (currentValue: string) => string | undefined;
	handleHistoryForward: () => string | undefined;
	suppressArrows: boolean;
	handleSetValueRef: (setter: (value: string) => void) => void;
	commandSuggestionsEnabled: boolean;
	wrapSuggestionLine: (line: string) => string;
	inputRef: React.RefObject<ShellInputHandle | null>;
	badgeText: string;
	runBadgeStyled: string;
	modeBadgeStyled: string;
	border: (text: string) => string;
	bottomBorder: string;
}) {
	return (
		<ShellInput
			ref={inputRef}
			innerWidth={innerWidth}
			useAscii={useAscii}
			borderColor={borderColor}
			inputRows={inputRows}
			inputPrefix={inputPrefix}
			inputPromptStyled={inputPromptStyled}
			inputContentWidth={inputContentWidth}
			textInputPlaceholder={textInputPlaceholder}
			textColor={textColor}
			inputPlaceholderColor={inputPlaceholderColor}
			isInputActive={isInputActive}
			onChange={handleInputChange}
			onSubmit={handleInputSubmit}
			onHistoryBack={handleHistoryBack}
			onHistoryForward={handleHistoryForward}
			suppressArrows={suppressArrows}
			setValueRef={handleSetValueRef}
			commandSuggestionsEnabled={commandSuggestionsEnabled}
			wrapSuggestionLine={wrapSuggestionLine}
			badgeText={badgeText}
			runBadgeStyled={runBadgeStyled}
			modeBadgeStyled={modeBadgeStyled}
			border={border}
			bottomBorder={bottomBorder}
		/>
	);
});

export default function App({
	projectDir,
	instanceId,
	harness,
	isolation,
	verbose,
	pluginMcpConfig,
	modelName,
	theme,
	initialSessionId,
	showSessionPicker,
	showSetup,
	workflowRef,
	workflow,
	pluginFlags,
	isolationPreset,
	ascii,
	athenaSessionId: initialAthenaSessionId,
	initialTelemetryDiagnosticsConsent,
}: Props) {
	const [clearCount, setClearCount] = useState(0);
	const perfEnabled = isPerfEnabled();
	usePerfRenderLog(perfEnabled, 'app.main.render');
	const [athenaSessionId, setAthenaSessionId] = useState(
		initialAthenaSessionId,
	);
	const [activeTheme, setActiveTheme] = useState(theme);
	const [runtimeState, setRuntimeState] = useState<{
		harness: AthenaHarness;
		isolation?: IsolationConfig;
		pluginMcpConfig?: string;
		modelName: string | null;
		workflowRef?: string;
		workflow?: WorkflowConfig;
	}>({
		harness,
		isolation,
		pluginMcpConfig,
		modelName,
		workflowRef,
		workflow,
	});
	const inputHistory = useInputHistory(projectDir);
	let initialPhase: AppPhase;
	if (showSetup) {
		initialPhase = {type: 'setup'};
	} else if (showSessionPicker) {
		initialPhase = {type: 'session-select'};
	} else {
		initialPhase = {type: 'main', initialSessionId};
	}
	const [phase, setPhase] = useState<AppPhase>(initialPhase);
	const sessionTelemetryMetricsRef = useRef<SessionMetrics>(
		EMPTY_SESSION_METRICS,
	);
	const sessionTelemetryCarryRef = useRef(createEmptySessionTelemetryCarry());

	useEffect(() => {
		if (!perfEnabled) return;
		logPerfEvent('app.start', {
			project_dir: projectDir,
			instance_id: instanceId,
		});
		return startEventLoopMonitor('app');
	}, [perfEnabled, projectDir, instanceId]);

	useEffect(() => {
		if (!perfEnabled) return;
		logPerfEvent('app.phase', {phase: phase.type});
	}, [perfEnabled, phase.type]);

	useEffect(() => {
		if (phase.type !== 'main') {
			return;
		}

		sessionTelemetryCarryRef.current = createEmptySessionTelemetryCarry();
		sessionTelemetryMetricsRef.current = EMPTY_SESSION_METRICS;
		trackSessionStarted({
			harness: runtimeState.harness,
			workflow: runtimeState.workflowRef,
			model: runtimeState.modelName ?? undefined,
		});

		const startTime = Date.now();
		return () => {
			const summary = buildSessionTelemetrySummary(
				sessionTelemetryCarryRef.current,
				sessionTelemetryMetricsRef.current,
			);
			trackSessionEnded({
				durationMs: Date.now() - startTime,
				toolCallCount: summary.toolCallCount,
				subagentCount: summary.subagentCount,
				permissionsAllowed: summary.permissionsAllowed,
				permissionsDenied: summary.permissionsDenied,
			});
		};
	}, [
		phase.type,
		athenaSessionId,
		runtimeState.harness,
		runtimeState.modelName,
		runtimeState.workflowRef,
	]);

	const handleProfilerRender = useCallback(
		(
			id: string,
			phaseName: string,
			actualDuration: number,
			baseDuration: number,
			startTime: number,
			commitTime: number,
		) => {
			logReactCommit(
				id,
				phaseName,
				actualDuration,
				baseDuration,
				startTime,
				commitTime,
			);
		},
		[],
	);

	const handleSessionSelect = useCallback((sessionId: string) => {
		// sessionId here is an athena session ID from the picker.
		// Look up the most recent adapter session ID for prompt resume.
		const meta = getSessionMeta(sessionId);
		const adapterIds = meta?.adapterSessionIds ?? [];
		const lastAdapterId = adapterIds[adapterIds.length - 1];

		setAthenaSessionId(sessionId);
		setPhase({type: 'main', initialSessionId: lastAdapterId});
	}, []);
	const handleSessionCancel = useCallback(() => {
		setPhase({type: 'main'});
	}, []);
	const handleShowSessions = useCallback(() => {
		setPhase({type: 'session-select'});
	}, []);
	const handleShowSetup = useCallback(() => {
		setPhase({type: 'setup'});
	}, []);
	const [sessions, setSessions] = useState<SessionEntry[]>([]);
	const [sessionsLoading, setSessionsLoading] = useState(false);

	useEffect(() => {
		if (phase.type !== 'session-select') {
			setSessions([]);
			return;
		}
		setSessionsLoading(true);
		// Defer heavy DB reads so the picker renders immediately with a spinner.
		const timer = setTimeout(() => {
			const athenaSessions = listSessions(projectDir);
			setSessions(
				athenaSessions.map(s => ({
					sessionId: s.id,
					summary: s.label ?? '',
					firstPrompt: s.firstPrompt ?? `Session ${s.id.slice(0, 8)}`,
					modified: new Date(s.updatedAt).toISOString(),
					created: new Date(s.createdAt).toISOString(),
					gitBranch: '',
					messageCount: s.eventCount ?? s.adapterSessionIds.length,
				})),
			);
			setSessionsLoading(false);
		}, 0);
		return () => clearTimeout(timer);
	}, [projectDir, phase.type]);

	const handleSetupComplete = useCallback(
		(setupResult: import('../../setup/SetupWizard').SetupResult) => {
			setActiveTheme(resolveTheme(setupResult.theme));
			try {
				const refreshed = bootstrapRuntimeConfig({
					projectDir,
					showSetup: false,
					pluginFlags,
					isolationPreset,
					verbose,
				});
				for (const warning of refreshed.warnings) {
					console.error(warning);
				}
				setRuntimeState({
					harness: refreshed.harness,
					isolation: refreshed.isolationConfig,
					pluginMcpConfig: refreshed.pluginMcpConfig,
					modelName: refreshed.modelName,
					workflowRef: refreshed.workflowRef,
					workflow: refreshed.workflow,
				});
			} catch (error) {
				console.error(`Error: ${(error as Error).message}`);
			}
			setPhase({type: 'main'});
		},
		[projectDir, pluginFlags, isolationPreset, verbose],
	);

	if (phase.type === 'setup') {
		return (
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.setup"
				onRender={handleProfilerRender}
			>
				<ThemeProvider value={activeTheme}>
					<SetupWizard
						onThemePreview={themeName => {
							setActiveTheme(resolveTheme(themeName));
						}}
						onComplete={handleSetupComplete}
					/>
				</ThemeProvider>
			</MaybeProfiler>
		);
	}

	if (phase.type === 'session-select') {
		return (
			<MaybeProfiler
				enabled={perfEnabled}
				id="app.session-select"
				onRender={handleProfilerRender}
			>
				<ErrorBoundary
					fallback={
						<Text color="red">
							[Session picker error -- starting new session]
						</Text>
					}
				>
					<SessionPicker
						sessions={sessions}
						loading={sessionsLoading}
						onSelect={handleSessionSelect}
						onCancel={handleSessionCancel}
					/>
				</ErrorBoundary>
			</MaybeProfiler>
		);
	}

	return (
		<ThemeProvider value={activeTheme}>
			<HookProvider
				projectDir={projectDir}
				instanceId={instanceId}
				harness={runtimeState.harness}
				allowedTools={runtimeState.isolation?.allowedTools}
				athenaSessionId={athenaSessionId}
			>
				<AppContent
					key={clearCount}
					projectDir={projectDir}
					instanceId={instanceId}
					harness={runtimeState.harness}
					isolation={runtimeState.isolation}
					verbose={verbose}
					pluginMcpConfig={runtimeState.pluginMcpConfig}
					modelName={runtimeState.modelName}
					athenaSessionId={athenaSessionId}
					initialSessionId={phase.initialSessionId}
					onClear={() => setClearCount(c => c + 1)}
					onShowSessions={handleShowSessions}
					onShowSetup={handleShowSetup}
					inputHistory={inputHistory}
					sessionTelemetryMetricsRef={sessionTelemetryMetricsRef}
					onSessionTelemetrySnapshot={metrics => {
						sessionTelemetryCarryRef.current = accumulateSessionTelemetryCarry(
							sessionTelemetryCarryRef.current,
							metrics,
						);
					}}
					workflowRef={runtimeState.workflowRef}
					workflow={runtimeState.workflow}
					ascii={ascii}
					initialTelemetryDiagnosticsConsent={
						initialTelemetryDiagnosticsConsent
					}
				/>
			</HookProvider>
		</ThemeProvider>
	);
}

function usePerfRenderLog(enabled: boolean, id: string) {
	const renderCountRef = useRef(0);
	renderCountRef.current += 1;

	useEffect(() => {
		if (!enabled) return;
		logPerfEvent('react.render', {
			id,
			count: renderCountRef.current,
		});
	});
}
