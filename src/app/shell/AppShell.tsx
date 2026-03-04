import process from 'node:process';
import React, {
	Profiler,
	useState,
	useCallback,
	useRef,
	useEffect,
	useMemo,
} from 'react';
import {Box, Static, Text, useApp, useInput, useStdout} from 'ink';
import {TextInput} from '@inkjs/ui';
import PermissionDialog from '../../ui/components/PermissionDialog';
import QuestionDialog from '../../ui/components/QuestionDialog';
import ErrorBoundary from '../../ui/components/ErrorBoundary';
import {
	HookProvider,
	useHookContextSelector,
} from '../providers/RuntimeProvider';
import {useHarnessProcess} from '../process/useHarnessProcess';
import {useHeaderMetrics} from '../../ui/hooks/useHeaderMetrics';
import {useAppMode} from '../../ui/hooks/useAppMode';
import {
	type InputHistory,
	useInputHistory,
} from '../../ui/hooks/useInputHistory';
import {useFeedNavigation} from '../../ui/hooks/useFeedNavigation';
import {useStaticFeed} from '../../ui/hooks/useStaticFeed';
import {useTodoPanel} from '../../ui/hooks/useTodoPanel';
import {useFeedKeyboard} from '../../ui/hooks/useFeedKeyboard';
import {useTodoKeyboard} from '../../ui/hooks/useTodoKeyboard';
import {useSpinner} from '../../ui/hooks/useSpinner';
import {useTimeline} from '../../ui/hooks/useTimeline';
import {useLayout} from '../../ui/hooks/useLayout';
import {buildBodyLines} from '../../ui/layout/buildBodyLines';
import {FeedGrid} from '../../ui/components/FeedGrid';
import {formatFeedRowLine} from '../../ui/components/FeedRow';
import {type TimelineEntry} from '../../core/feed/timeline';
import {FrameRow} from '../../ui/components/FrameRow';
import {useFeedColumns} from '../../ui/hooks/useFeedColumns';
import {buildFrameLines} from '../../ui/layout/buildFrameLines';
import {buildHeaderModel} from '../../ui/header/model';
import {renderHeaderLines} from '../../ui/header/renderLines';
import type {Message as MessageType} from '../../shared/types/common';
import {generateId} from '../../shared/utils/id';
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
import type {AthenaHarness} from '../../infra/plugins/config';
import {listSessions, getSessionMeta} from '../../infra/sessions/registry';
import {fit, fitAnsi} from '../../shared/utils/format';
import {frameGlyphs} from '../../ui/glyphs/index';
import type {WorkflowConfig} from '../../core/workflows/types';
import SetupWizard from '../../setup/SetupWizard';
import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {
	renderDetailLines,
	renderMarkdownToLines,
} from '../../ui/layout/renderDetailLines';
import chalk from 'chalk';
import {evaluateEscapeInterruptGate} from './escapeInterruptGate';
import {
	isPerfEnabled,
	logPerfEvent,
	logReactCommit,
	startEventLoopMonitor,
	startInputMeasure,
} from '../../shared/utils/perf';

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
	workflowFlag?: string;
	pluginFlags?: string[];
	isolationPreset: IsolationPreset;
	ascii?: boolean;
	showSetup?: boolean;
	athenaSessionId: string;
};

type AppPhase =
	| {type: 'setup'}
	| {type: 'session-select'}
	| {type: 'main'; initialSessionId?: string};

type FocusMode = 'feed' | 'input' | 'todo';
type InputMode = 'normal' | 'search';

function deriveInputMode(value: string): InputMode {
	if (value.startsWith('/')) return 'search';
	return 'normal';
}

/** Fallback for crashed PermissionDialog -- lets user press Escape to deny. */

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

/** Fallback for crashed QuestionDialog -- lets user press Escape to skip. */
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
	workflowRef,
	workflow,
	ascii,
}: Omit<
	Props,
	| 'showSessionPicker'
	| 'showSetup'
	| 'theme'
	| 'workflowFlag'
	| 'pluginFlags'
	| 'isolationPreset'
> & {
	initialSessionId?: string;
	onClear: () => void;
	onShowSessions: () => void;
	onShowSetup: () => void;
	inputHistory: InputHistory;
}) {
	const [messages, setMessages] = useState<MessageType[]>([]);
	const [focusMode, setFocusMode] = useState<FocusMode>('feed');
	const [inputMode, setInputMode] = useState<InputMode>('normal');
	const [hintsForced, setHintsForced] = useState<boolean | null>(null);
	const [showRunOverlay, setShowRunOverlay] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [pagerActive, setPagerActive] = useState(false);
	const runFilter = 'all';
	const errorsOnly = false;

	const messagesRef = useRef(messages);
	messagesRef.current = messages;

	const theme = useTheme();
	const feedEvents = useHookContextSelector(value => value.feedEvents);
	const feedItems = useHookContextSelector(value => value.items);
	const tasks = useHookContextSelector(value => value.tasks);
	const session = useHookContextSelector(value => value.session);
	const currentRun = useHookContextSelector(value => value.currentRun);
	const currentPermissionRequest = useHookContextSelector(
		value => value.currentPermissionRequest,
	);
	const permissionQueueCount = useHookContextSelector(
		value => value.permissionQueueCount,
	);
	const resolvePermission = useHookContextSelector(
		value => value.resolvePermission,
	);
	const currentQuestionRequest = useHookContextSelector(
		value => value.currentQuestionRequest,
	);
	const questionQueueCount = useHookContextSelector(
		value => value.questionQueueCount,
	);
	const resolveQuestion = useHookContextSelector(
		value => value.resolveQuestion,
	);
	const postByToolUseId = useHookContextSelector(
		value => value.postByToolUseId,
	);
	const allocateSeq = useHookContextSelector(value => value.allocateSeq);
	const clearEvents = useHookContextSelector(value => value.clearEvents);
	const printTaskSnapshot = useHookContextSelector(
		value => value.printTaskSnapshot,
	);
	const recordTokens = useHookContextSelector(value => value.recordTokens);
	const restoredTokens = useHookContextSelector(value => value.restoredTokens);
	const hookCommandFeed = useMemo(
		() => ({printTaskSnapshot}),
		[printTaskSnapshot],
	);

	const currentSessionId = session?.session_id ?? null;
	const sessionScope = useMemo(() => {
		const persisted = getSessionMeta(athenaSessionId)?.adapterSessionIds ?? [];
		const ids = [...persisted];
		if (currentSessionId && !ids.includes(currentSessionId)) {
			ids.push(currentSessionId);
		}
		const total = ids.length;
		const index =
			currentSessionId !== null ? ids.indexOf(currentSessionId) + 1 : null;
		return {
			current: index !== null && index > 0 ? index : null,
			total,
		};
	}, [athenaSessionId, currentSessionId]);
	const currentRunId = currentRun?.run_id ?? null;
	const currentRunStartedAt = currentRun?.started_at ?? null;
	const currentRunPromptPreview = currentRun?.trigger.prompt_preview;
	const timelineCurrentRun = useMemo(
		() =>
			currentRunId && currentRunStartedAt !== null
				? {
						run_id: currentRunId,
						trigger: {prompt_preview: currentRunPromptPreview},
						started_at: currentRunStartedAt,
					}
				: null,
		[currentRunId, currentRunStartedAt, currentRunPromptPreview],
	);

	const onExitTokens = useCallback(
		(tokens: import('../../shared/types/headerMetrics').TokenUsage) => {
			if (session?.session_id) {
				recordTokens(session.session_id, tokens);
			}
		},
		[session?.session_id, recordTokens],
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
			trackOutput: false,
			trackStreamingText: false,
			tokenUpdateMs: 250,
		},
	});
	const {exit} = useApp();
	const {stdout} = useStdout();
	const terminalWidth = stdout.columns;
	const terminalRows = stdout.rows;
	// Avoid writing into the terminal's last column, which can trigger
	// auto-wrap artifacts on some terminals/fonts and break right borders.
	const safeTerminalWidth = Math.max(4, terminalWidth - 1);

	// Hold initialSessionId as intent — consumed on first user prompt submission.
	// Deferred spawn: no Claude process runs until user provides real input.
	const initialSessionRef = useRef(initialSessionId);

	const metrics = useHeaderMetrics(feedEvents);
	const appMode = useAppMode(
		isHarnessRunning,
		currentPermissionRequest,
		currentQuestionRequest,
	);
	const dialogActive =
		appMode.type === 'permission' || appMode.type === 'question';

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
		clearEvents();
		process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
		onClear();
	}, [clearEvents, onClear]);

	// ── Timeline + Todo + Layout ────────────────────────────

	const timeline = useTimeline({
		feedItems,
		feedEvents,
		currentRun: timelineCurrentRun,
		runFilter,
		errorsOnly,
		searchQuery,
		postByToolUseId,
		verbose,
	});
	const {
		runSummaries,
		filteredEntries,
		searchMatches,
		searchMatchSet,
		searchMatchPos,
		setSearchMatchPos,
	} = timeline;

	const todoPanel = useTodoPanel({
		tasks,
		isWorking: appMode.type === 'working',
	});

	useEffect(() => {
		if (
			focusMode === 'todo' &&
			(!todoPanel.todoVisible || todoPanel.visibleTodoItems.length === 0)
		) {
			setFocusMode('feed');
		}
	}, [focusMode, todoPanel.todoVisible, todoPanel.visibleTodoItems.length]);

	const estimatedTodoRows = todoPanel.todoVisible
		? Math.min(8, 2 + todoPanel.visibleTodoItems.length)
		: 0;
	const estimatedRunRows = showRunOverlay
		? Math.min(6, 1 + Math.max(1, runSummaries.length))
		: 0;
	// Static scrollback: compute high-water mark from previous render's viewport,
	// then feed it as a floor constraint into navigation.
	const staticHwmRef = useRef(0);
	const feedNav = useFeedNavigation({
		filteredEntries,
		feedContentRows: Math.max(
			1,
			terminalRows - 10 - estimatedTodoRows - estimatedRunRows,
		),
		staticFloor: staticHwmRef.current,
	});

	const staticHighWaterMark = useStaticFeed({
		filteredEntries,
		feedViewportStart: feedNav.feedViewportStart,
		tailFollow: feedNav.tailFollow,
	});
	staticHwmRef.current = staticHighWaterMark;

	// Compute frame dimensions early (only depends on terminalWidth)
	const frameWidth = safeTerminalWidth;
	const innerWidth = frameWidth - 2;

	// ── Refs for callbacks ──────────────────────────────────

	const filteredEntriesRef = useRef(filteredEntries);
	filteredEntriesRef.current = filteredEntries;

	// ── Prompt submission ───────────────────────────────────

	const submitPromptOrSlashCommand = useCallback(
		(value: string) => {
			if (!value.trim()) return;
			inputHistory.push(value);
			const result = parseInput(value);
			if (result.type === 'prompt') {
				addMessage('user', result.text);
				const sessionToResume = currentSessionId ?? initialSessionRef.current;
				spawnHarness(result.text, sessionToResume ?? undefined).catch(
					(err: unknown) => console.error('[athena] spawn failed:', err),
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
					spawn: spawnHarness,
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

	// ── Input handling ──────────────────────────────────────

	const setInputValueRef = useRef<(value: string) => void>(() => {});
	const inputValueRef = useRef('');
	const [inputSeed, setInputSeed] = useState<{value: string; rev: number}>({
		value: '',
		rev: 0,
	});

	const syncInputModeFromValue = useCallback((value: string) => {
		const nextMode = deriveInputMode(value);
		setInputMode(prev => (prev === nextMode ? prev : nextMode));
		if (value.length === 0) {
			setSearchQuery('');
		}
	}, []);

	const setInputValueProgrammatically = useCallback(
		(value: string) => {
			inputValueRef.current = value;
			syncInputModeFromValue(value);
			setInputSeed(prev => ({value, rev: prev.rev + 1}));
		},
		[syncInputModeFromValue],
	);
	setInputValueRef.current = setInputValueProgrammatically;

	const handleInputSubmit = useCallback(
		(rawValue: string) => {
			const trimmed = rawValue.trim();
			const resetInput = () => {
				setInputValueRef.current('');
				setInputMode('normal');
				setFocusMode('feed');
			};
			if (!trimmed) {
				resetInput();
				return;
			}
			const parsedSlash = parseInput(trimmed);
			if (parsedSlash.type === 'command') {
				submitPromptOrSlashCommand(trimmed);
				resetInput();
				return;
			}
			if (trimmed.startsWith('/') || inputMode === 'search') {
				const query = trimmed.replace(/^\//, '').trim();
				setSearchQuery(query);
				if (query.length > 0) {
					const q = query.toLowerCase();
					const entries = filteredEntriesRef.current;
					let firstIdx = -1;
					for (let i = staticHwmRef.current; i < entries.length; i++) {
						if (entries[i]!.searchText.toLowerCase().includes(q)) {
							firstIdx = i;
							break;
						}
					}
					if (firstIdx >= 0) {
						feedNav.setFeedCursor(firstIdx);
						feedNav.setTailFollow(false);
						setSearchMatchPos(0);
					}
				}
				resetInput();
				return;
			}
			submitPromptOrSlashCommand(trimmed);
			resetInput();
		},
		[inputMode, submitPromptOrSlashCommand, feedNav, setSearchMatchPos],
	);

	const handleMainInputChange = useCallback(
		(value: string) => {
			inputValueRef.current = value;
			syncInputModeFromValue(value);
		},
		[syncInputModeFromValue],
	);

	const handleMainInputSubmit = useCallback(
		(value: string) => {
			if (value.endsWith('\\')) {
				setInputValueProgrammatically(value.slice(0, -1) + '\n');
				return;
			}
			handleInputSubmit(value);
		},
		[handleInputSubmit, setInputValueProgrammatically],
	);

	// ── Frame lines + Layout ────────────────────────────────

	// Derive last run status for contextual input prompt (X2)
	const lastRunStatus = useMemo(() => {
		if (isHarnessRunning) return null;
		const last = runSummaries.at(-1);
		if (!last) return null;
		if (last.status === 'SUCCEEDED') return 'completed' as const;
		if (last.status === 'FAILED') return 'failed' as const;
		if (last.status === 'CANCELLED') return 'aborted' as const;
		return null;
	}, [isHarnessRunning, runSummaries]);

	const visibleSearchMatches = useMemo(
		() => searchMatches.filter(idx => idx >= staticHighWaterMark),
		[searchMatches, staticHighWaterMark],
	);

	const frame = useMemo(
		() =>
			buildFrameLines({
				innerWidth,
				focusMode,
				inputMode,
				searchQuery,
				searchMatches: visibleSearchMatches,
				searchMatchPos,
				isClaudeRunning: isHarnessRunning,
				inputValue: '',
				cursorOffset: 0,
				dialogActive,
				dialogType: appMode.type,
				accentColor: theme.inputPrompt,
				hintsForced,
				ascii: !!ascii,
				lastRunStatus,
				skipInputLines: true,
			}),
		[
			innerWidth,
			focusMode,
			inputMode,
			searchQuery,
			visibleSearchMatches,
			searchMatchPos,
			isHarnessRunning,
			dialogActive,
			appMode.type,
			theme.inputPrompt,
			hintsForced,
			ascii,
			lastRunStatus,
		],
	);

	const footerRows = (frame.footerHelp !== null ? 1 : 0) + 1;

	const layout = useLayout({
		terminalRows,
		terminalWidth: safeTerminalWidth,
		showRunOverlay,
		runSummaries,
		todoPanel,
		footerRows,
	});

	const {
		feedHeaderRows,
		feedContentRows,
		actualTodoRows,
		actualRunOverlayRows,
		pageStep,
	} = layout;

	const fr = useMemo(() => frameGlyphs(!!ascii), [ascii]);
	const {topBorder, bottomBorder, sectionBorder} = useMemo(
		() => ({
			topBorder: `${fr.topLeft}${fr.horizontal.repeat(innerWidth)}${fr.topRight}`,
			bottomBorder: `${fr.bottomLeft}${fr.horizontal.repeat(innerWidth)}${fr.bottomRight}`,
			sectionBorder: `${fr.teeLeft}${fr.horizontal.repeat(innerWidth)}${fr.teeRight}`,
		}),
		[fr, innerWidth],
	);
	const frameLine = useCallback(
		(content: string): string =>
			`${fr.vertical}${fitAnsi(content, innerWidth)}${fr.vertical}`,
		[fr.vertical, innerWidth],
	);

	// ── Focus cycling ───────────────────────────────────────

	const visibleTodoItemsRef = useRef(todoPanel.visibleTodoItems);
	visibleTodoItemsRef.current = todoPanel.visibleTodoItems;

	const cycleFocus = useCallback(() => {
		setFocusMode(prev => {
			if (prev === 'feed') return 'input';
			if (prev === 'input') {
				if (todoPanel.todoVisible && visibleTodoItemsRef.current.length > 0)
					return 'todo';
				feedNav.jumpToTail();
				return 'feed';
			}
			feedNav.jumpToTail();
			return 'feed';
		});
	}, [todoPanel.todoVisible, feedNav]);

	// ── Permission/question handlers ────────────────────────

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

	// ── Keyboard hooks ──────────────────────────────────────

	const interruptEscapeAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!isHarnessRunning || focusMode !== 'feed') {
			interruptEscapeAtRef.current = null;
		}
	}, [isHarnessRunning, focusMode]);

	useInput(
		(input, key) => {
			const done = startInputMeasure('app.global', input, key);
			try {
				if (dialogActive) return;

				const interruptGate = evaluateEscapeInterruptGate({
					keyEscape: key.escape,
					isHarnessRunning,
					focusMode,
					lastEscapeAtMs: interruptEscapeAtRef.current,
					nowMs: Date.now(),
				});
				interruptEscapeAtRef.current = interruptGate.nextLastEscapeAtMs;
				if (interruptGate.shouldInterrupt) {
					interrupt();
					return;
				}
				if (key.ctrl && input === 't') {
					todoPanel.setTodoVisible(v => !v);
					if (focusMode === 'todo') setFocusMode('feed');
					return;
				}
				if (key.ctrl && input === '/') {
					setHintsForced(prev => (prev === null ? true : prev ? false : null));
					return;
				}
				if (focusMode === 'input') {
					if (key.escape) {
						setFocusMode('feed');
						setInputMode('normal');
						return;
					}
					if (key.tab) {
						cycleFocus();
						return;
					}
					if (key.ctrl && input === 'p') {
						const prev = inputHistory.back(inputValueRef.current);
						if (prev !== undefined) setInputValueRef.current(prev);
						return;
					}
					if (key.ctrl && input === 'n') {
						const next = inputHistory.forward();
						if (next !== undefined) setInputValueRef.current(next);
						return;
					}
				}
			} finally {
				done();
			}
		},
		{isActive: !dialogActive && !pagerActive},
	);

	// ── Pager mode ──────────────────────────────────────────
	//
	// The pager uses the terminal's alternate screen buffer (\x1B[?1049h).
	// IMPORTANT: We must NOT write to stdout during a React render cycle —
	// Ink's log-update will immediately overwrite the alternate buffer.
	// Instead, we set pagerActive=true first (so Ink renders <Box />),
	// then write content in a useEffect AFTER Ink commits the empty output.

	const PAGER_MARGIN = 3;
	const pendingPagerEntryRef = useRef<TimelineEntry | null>(null);

	const handleExpandForPager = useCallback(() => {
		const entry = filteredEntriesRef.current[feedNav.feedCursor];
		if (!entry?.expandable) return;
		pendingPagerEntryRef.current = entry;
		setPagerActive(true);
	}, [feedNav.feedCursor]);

	// Write pager content AFTER Ink has committed the empty <Box /> render.
	useEffect(() => {
		if (!pagerActive || !pendingPagerEntryRef.current) return;
		const entry = pendingPagerEntryRef.current;
		pendingPagerEntryRef.current = null;

		const contentWidth = Math.max(
			10,
			(process.stdout.columns ?? 80) - PAGER_MARGIN * 2,
		);
		const margin = ' '.repeat(PAGER_MARGIN);

		let lines: string[];
		if (entry.feedEvent) {
			lines = renderDetailLines(
				entry.feedEvent,
				contentWidth,
				entry.pairedPostEvent,
			).lines;
		} else {
			lines = renderMarkdownToLines(entry.details, contentWidth);
		}

		const marginedLines = lines.map(line => margin + line);

		process.stdout.write('\x1B[?1049h');
		process.stdout.write('\x1B[H');
		process.stdout.write(marginedLines.join('\n') + '\n\n');
		process.stdout.write(
			margin + chalk.dim('(press q or Escape to return)') + '\n',
		);
	}, [pagerActive]);

	// Pager exit handler
	useInput(
		(input, key) => {
			if (key.escape || input === 'q' || input === 'Q') {
				process.stdout.write('\x1B[?1049l');
				setPagerActive(false);
			}
		},
		{isActive: pagerActive},
	);

	useFeedKeyboard({
		isActive: focusMode === 'feed' && !dialogActive && !pagerActive,
		pageStep,
		searchMatches: visibleSearchMatches,
		callbacks: {
			moveFeedCursor: feedNav.moveFeedCursor,
			jumpToTail: feedNav.jumpToTail,
			jumpToTop: feedNav.jumpToTop,
			expandAtCursor: handleExpandForPager,
			cycleFocus,
			setFocusMode,
			setInputMode,
			setInputValue: (v: string) => setInputValueRef.current(v),
			setShowRunOverlay,
			setSearchQuery,
			setSearchMatchPos,
			setFeedCursor: feedNav.setFeedCursor,
			setTailFollow: feedNav.setTailFollow,
		},
	});

	useTodoKeyboard({
		isActive: focusMode === 'todo' && !dialogActive,
		todoCursor: todoPanel.todoCursor,
		visibleTodoItems: todoPanel.visibleTodoItems,
		filteredEntries,
		callbacks: {
			setFocusMode,
			setInputMode,
			setInputValue: (v: string) => setInputValueRef.current(v),
			setTodoCursor: todoPanel.setTodoCursor,
			setFeedCursor: feedNav.setFeedCursor,
			setTailFollow: feedNav.setTailFollow,
			toggleTodoStatus: todoPanel.toggleTodoStatus,
			cycleFocus,
		},
	});

	const hasColor = !process.env['NO_COLOR'];
	const useAscii = !!ascii;
	const spinnerFrame = useSpinner(
		appMode.type === 'working' && todoPanel.todoVisible && !pagerActive,
	);

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
		return renderHeaderLines(headerModel, innerWidth, hasColor)[0];
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
	]);

	// ── Body lines ──────────────────────────────────────────

	const prefixBodyLines = useMemo(
		() =>
			buildBodyLines({
				innerWidth,
				todo: {
					actualTodoRows,
					todoPanel: {
						todoScroll: todoPanel.todoScroll,
						todoCursor: todoPanel.todoCursor,
						visibleTodoItems: todoPanel.visibleTodoItems,
					},
					focusMode,
					ascii: useAscii,
					colors: todoColors,
					appMode: appMode.type,
					doneCount: todoPanel.doneCount,
					totalCount: todoPanel.todoItems.length,
					spinnerFrame,
				},
				runOverlay: {actualRunOverlayRows, runSummaries, runFilter},
				theme,
			}),
		[
			innerWidth,
			actualTodoRows,
			todoPanel.todoScroll,
			todoPanel.todoCursor,
			todoPanel.visibleTodoItems,
			focusMode,
			useAscii,
			todoColors,
			appMode.type,
			todoPanel.doneCount,
			todoPanel.todoItems.length,
			spinnerFrame,
			actualRunOverlayRows,
			runSummaries,
			runFilter,
			theme,
		],
	);

	const feedCols = useFeedColumns(filteredEntries, innerWidth);

	// ── Static scrollback slicing ────────────────────────────
	const dynamicEntries = useMemo(
		() => filteredEntries.slice(staticHighWaterMark),
		[filteredEntries, staticHighWaterMark],
	);
	const adjustedSearchMatchSet = useMemo(() => {
		if (staticHighWaterMark === 0) return searchMatchSet;
		const adjusted = new Set<number>();
		for (const idx of searchMatchSet) {
			if (idx >= staticHighWaterMark) {
				adjusted.add(idx - staticHighWaterMark);
			}
		}
		return adjusted;
	}, [searchMatchSet, staticHighWaterMark]);
	// Only recompute when HWM advances — Static already rendered previous items.
	// Using filteredEntriesRef avoids re-slicing on every new event.
	const staticEntries = useMemo(
		() => filteredEntriesRef.current.slice(0, staticHighWaterMark),
		[staticHighWaterMark],
	);

	const runBadge = isHarnessRunning ? '[RUN]' : '[IDLE]';
	const modeBadges = [
		runBadge,
		...(inputMode === 'search' ? ['[SEARCH]'] : []),
	];
	const badgeText = modeBadges.join('');
	const inputPrefix = 'input> ';
	const inputContentWidth = Math.max(
		1,
		innerWidth - inputPrefix.length - badgeText.length,
	);
	const inputPlaceholder =
		inputMode === 'search'
			? '/search'
			: lastRunStatus === 'completed'
				? 'Run complete - type a follow-up'
				: lastRunStatus === 'failed' || lastRunStatus === 'aborted'
					? 'Run failed - type a follow-up'
					: 'Type a prompt or /command';
	const dialogPlaceholder =
		appMode.type === 'question'
			? 'Answer question in dialog...'
			: 'Respond to permission dialog...';
	const textInputPlaceholder = dialogActive
		? dialogPlaceholder
		: inputPlaceholder;

	// ── Render ──────────────────────────────────────────────

	if (pagerActive) {
		return <Box />;
	}

	return (
		<Box flexDirection="column" width={frameWidth}>
			{staticHighWaterMark > 0 && (
				<Static items={staticEntries}>
					{(entry: TimelineEntry) => (
						<Text key={entry.id}>
							{frameLine(
								formatFeedRowLine({
									entry,
									cols: feedCols,
									focused: false,
									expanded: false,
									matched: false,
									isDuplicateActor: entry.duplicateActor,
									ascii: useAscii,
									theme,
									innerWidth,
								}),
							)}
						</Text>
					)}
				</Static>
			)}
			<Text>{topBorder}</Text>
			<Text>{frameLine(headerLine1)}</Text>
			<Text>{sectionBorder}</Text>
			{prefixBodyLines.map((line, index) => (
				<Text key={`body-${index}`}>{frameLine(line)}</Text>
			))}
			<FeedGrid
				feedHeaderRows={feedHeaderRows}
				feedContentRows={feedContentRows}
				feedViewportStart={feedNav.feedViewportStart - staticHighWaterMark}
				filteredEntries={dynamicEntries}
				feedCursor={feedNav.feedCursor - staticHighWaterMark}
				focusMode={focusMode}
				searchMatchSet={adjustedSearchMatchSet}
				ascii={useAscii}
				theme={theme}
				innerWidth={innerWidth}
				cols={feedCols}
			/>
			<Text>{sectionBorder}</Text>
			{frame.footerHelp !== null && (
				<Text>{frameLine(fit(frame.footerHelp, innerWidth))}</Text>
			)}
			<FrameRow innerWidth={innerWidth} ascii={useAscii}>
				<Box width={inputPrefix.length} flexShrink={0}>
					<Text color={theme.inputPrompt}>{inputPrefix}</Text>
				</Box>
				<Box width={inputContentWidth} flexShrink={0}>
					<TextInput
						key={`app-main-input-${inputSeed.rev}`}
						defaultValue={inputSeed.value}
						placeholder={textInputPlaceholder}
						isDisabled={focusMode !== 'input' || dialogActive}
						onChange={handleMainInputChange}
						onSubmit={handleMainInputSubmit}
					/>
				</Box>
				<Box width={badgeText.length} flexShrink={0}>
					<Text>{badgeText}</Text>
				</Box>
			</FrameRow>
			<Text>{bottomBorder}</Text>
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
		</Box>
	);
}

export default function App({
	projectDir,
	instanceId,
	harness,
	isolation,
	verbose,
	version,
	pluginMcpConfig,
	modelName,
	theme,
	initialSessionId,
	showSessionPicker,
	showSetup,
	workflowRef,
	workflow,
	workflowFlag,
	pluginFlags,
	isolationPreset,
	ascii,
	athenaSessionId: initialAthenaSessionId,
}: Props) {
	const [clearCount, setClearCount] = useState(0);
	const perfEnabled = isPerfEnabled();
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
	const initialPhase: AppPhase = showSetup
		? {type: 'setup'}
		: showSessionPicker
			? {type: 'session-select'}
			: {type: 'main', initialSessionId};
	const [phase, setPhase] = useState<AppPhase>(initialPhase);

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

	const withProfiler = (id: string, node: React.ReactElement) =>
		perfEnabled ? (
			<Profiler id={id} onRender={handleProfilerRender}>
				{node}
			</Profiler>
		) : (
			node
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
	const sessions = useMemo((): SessionEntry[] => {
		if (phase.type !== 'session-select') return [];
		// Use athena sessions, mapped to SessionEntry format for the picker
		const athenaSessions = listSessions(projectDir);
		return athenaSessions.map(s => ({
			sessionId: s.id,
			summary: s.label ?? '',
			firstPrompt: `Session ${s.id.slice(0, 8)}`,
			modified: new Date(s.updatedAt).toISOString(),
			created: new Date(s.createdAt).toISOString(),
			gitBranch: '',
			messageCount: s.eventCount ?? s.adapterSessionIds.length,
		}));
	}, [projectDir, phase]);

	if (phase.type === 'setup') {
		return withProfiler(
			'app.setup',
			<ThemeProvider value={activeTheme}>
				<SetupWizard
					onThemePreview={themeName => {
						setActiveTheme(resolveTheme(themeName));
					}}
					onComplete={setupResult => {
						setActiveTheme(resolveTheme(setupResult.theme));
						try {
							const refreshed = bootstrapRuntimeConfig({
								projectDir,
								showSetup: false,
								workflowFlag,
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
					}}
				/>
			</ThemeProvider>,
		);
	}

	if (phase.type === 'session-select') {
		return withProfiler(
			'app.session-select',
			<ErrorBoundary
				fallback={
					<Text color="red">
						[Session picker error -- starting new session]
					</Text>
				}
			>
				<SessionPicker
					sessions={sessions}
					onSelect={handleSessionSelect}
					onCancel={handleSessionCancel}
				/>
			</ErrorBoundary>,
		);
	}

	return withProfiler(
		'app.main',
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
					version={version}
					pluginMcpConfig={runtimeState.pluginMcpConfig}
					modelName={runtimeState.modelName}
					athenaSessionId={athenaSessionId}
					initialSessionId={phase.initialSessionId}
					onClear={() => setClearCount(c => c + 1)}
					onShowSessions={handleShowSessions}
					onShowSetup={handleShowSetup}
					inputHistory={inputHistory}
					workflowRef={runtimeState.workflowRef}
					workflow={runtimeState.workflow}
					ascii={ascii}
				/>
			</HookProvider>
		</ThemeProvider>,
	);
}
