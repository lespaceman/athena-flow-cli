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
import ErrorBoundary from '../../ui/components/ErrorBoundary';
import {HookProvider} from '../providers/RuntimeProvider';
import {useHarnessProcess} from '../process/useHarnessProcess';
import {useHeaderMetrics} from '../../ui/hooks/useHeaderMetrics';
import {useTerminalTitle} from '../../ui/hooks/useTerminalTitle';
import {
	CommandSuggestionPanel,
	type CommandSuggestionPanelHandle,
} from '../../ui/components/CommandSuggestionPanel';
import {useAppMode} from '../../ui/hooks/useAppMode';
import {
	type InputHistory,
	useInputHistory,
} from '../../ui/hooks/useInputHistory';
import {useFeedNavigation} from '../../ui/hooks/useFeedNavigation';
import {useTodoPanel} from '../../ui/hooks/useTodoPanel';
import {useFeedKeyboard} from '../../ui/hooks/useFeedKeyboard';
import {useTodoKeyboard} from '../../ui/hooks/useTodoKeyboard';
import {useSpinner} from '../../ui/hooks/useSpinner';
import {useTimeline} from '../../ui/hooks/useTimeline';
import {useLayout} from '../../ui/hooks/useLayout';
import {usePager} from '../../ui/hooks/usePager';
import {useFrameChrome} from '../../ui/hooks/useFrameChrome';
import {
	buildBodyLines,
	buildTodoHeaderLine,
} from '../../ui/layout/buildBodyLines';
import {FeedGrid} from '../../ui/components/FeedGrid';
import {FrameRow} from '../../ui/components/FrameRow';
import {MultiLineInput} from '../../ui/components/MultiLineInput';
import {useFeedColumns} from '../../ui/hooks/useFeedColumns';
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
import chalk from 'chalk';
import {fit} from '../../shared/utils/format';
import {copyToClipboard} from '../../shared/utils/clipboard';
import {extractYankContent} from '../../ui/utils/yankContent';
import type {WorkflowConfig} from '../../core/workflows/types';
import SetupWizard from '../../setup/SetupWizard';
import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import type {FocusMode, InputMode} from './types';
import {useRuntimeSelectors} from './useRuntimeSelectors';
import {useSessionScope, useTimelineCurrentRun} from './useSessionScope';
import {useShellInput} from './useShellInput';
import {useInputLayout} from './useInputLayout';
import {useGlobalKeyboard} from './useGlobalKeyboard';
import {
	isPerfEnabled,
	logPerfEvent,
	logReactCommit,
	startEventLoopMonitor,
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
	| 'pluginFlags'
	| 'isolationPreset'
	| 'version'
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
	const [toastMessage, setToastMessage] = useState<string | null>(null);
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;

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
		recordTokens,
		restoredTokens,
		hookCommandFeed,
	} = useRuntimeSelectors();

	const currentSessionId = session?.session_id ?? null;
	const sessionScope = useSessionScope(athenaSessionId, currentSessionId);
	const timelineCurrentRun = useTimelineCurrentRun(currentRun);

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
	// Reserve 1 column to prevent terminal auto-wrap: writing the last column
	// causes many terminals to move the cursor to the next line, consuming an
	// extra row and breaking the layout.
	const safeTerminalWidth = Math.max(4, terminalWidth - 1);

	// Hold initialSessionId as intent — consumed on first user prompt submission.
	// Deferred spawn: no Claude process runs until user provides real input.
	const initialSessionRef = useRef(initialSessionId);

	const metrics = useHeaderMetrics(feedEvents);
	useTerminalTitle(feedEvents, isHarnessRunning);
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

	const timeline = useTimeline({
		feedItems,
		feedEvents,
		currentRun: timelineCurrentRun,
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

	const staticHwmRef = useRef(0);
	const setFeedCursorRef = useRef<(cursor: number) => void>(() => {});
	const setTailFollowRef = useRef<(follow: boolean) => void>(() => {});

	const frameWidth = safeTerminalWidth;
	const innerWidth = frameWidth - 2;

	const filteredEntriesRef = useRef(filteredEntries);
	filteredEntriesRef.current = filteredEntries;

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
		setInputMode,
		setFocusMode,
		setSearchQuery,
		submitPromptOrSlashCommand,
		filteredEntriesRef,
		staticHwmRef,
		setFeedCursorRef,
		setTailFollowRef,
		setSearchMatchPos,
		getSelectedCommand: () => getSelectedCommandRef.current(),
	});

	const suggestionPanelRef = useRef<CommandSuggestionPanelHandle>(null);
	getSelectedCommandRef.current = () =>
		suggestionPanelRef.current?.getSelectedCommand();

	// Wrap onChange to notify the suggestion panel (isolated re-render).
	// The panel's notifyInputChanged only triggers a re-render of the panel
	// component — not the entire AppContent tree.
	const handleInputChange = useCallback(
		(value: string) => {
			handleMainInputChange(value);
			suggestionPanelRef.current?.notifyInputChanged();
		},
		[handleMainInputChange],
	);

	const {back: handleHistoryBack, forward: handleHistoryForward} = inputHistory;

	const stableSetInputValue = useCallback(
		(v: string) => setInputValueRef.current(v),
		[setInputValueRef],
	);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const stableGetInputValue = useCallback(() => inputValueRef.current, []);
	const staticHighWaterMark = 0;
	staticHwmRef.current = staticHighWaterMark;

	const {
		frame,
		footerRows,
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
		dialogType: appMode.type,
		hintsForced,
		ascii: !!ascii,
		accentColor: theme.inputPrompt,
		runSummaries,
		staticHighWaterMark,
	});

	const layout = useLayout({
		terminalRows,
		terminalWidth: safeTerminalWidth,
		showRunOverlay,
		runSummaries,
		todoPanel,
		footerRows,
		inputRows,
	});

	const {
		feedHeaderRows,
		feedContentRows,
		actualTodoRows,
		actualRunOverlayRows,
	} = layout;
	// FeedGrid subtracts 1 from feedContentRows for the header divider line.
	// The navigation viewport must match the actual visible data rows.
	const showFeedHeaderDivider = feedHeaderRows > 0 && feedContentRows > 1;
	const visibleFeedContentRows = Math.max(
		1,
		feedContentRows - (showFeedHeaderDivider ? 1 : 0),
	);
	const pageStep = Math.max(1, Math.floor(visibleFeedContentRows / 2));
	const feedNav = useFeedNavigation({
		filteredEntries,
		feedContentRows: visibleFeedContentRows,
		staticFloor: 0,
	});
	setFeedCursorRef.current = feedNav.setFeedCursor;
	setTailFollowRef.current = feedNav.setTailFollow;

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
			setFocusMode,
			setInputMode,
			setHintsForced,
			setTodoVisible: todoPanel.setTodoVisible,
			historyBack: inputHistory.back,
			historyForward: inputHistory.forward,
			getInputValue: stableGetInputValue,
			setInputValue: stableSetInputValue,
			inputMode,
			commandSuggestions: {
				visible: () => suggestionPanelRef.current?.showSuggestions ?? false,
				moveUp: () => suggestionPanelRef.current?.moveUp(),
				moveDown: () => suggestionPanelRef.current?.moveDown(),
				tab: () => {
					const cmd = suggestionPanelRef.current?.getSelectedCommand();
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
			setFocusMode,
			setInputMode,
			setInputValue: stableSetInputValue,
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
			setInputValue: stableSetInputValue,
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
		appMode.type === 'working' &&
			todoPanel.todoVisible &&
			!pagerActive &&
			filteredEntries.length < 500,
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

	// Memo 1: Todo header line — depends on spinnerFrame, updates every 500ms
	const todoHeaderLine = useMemo(
		() =>
			actualTodoRows > 0
				? buildTodoHeaderLine(
						innerWidth,
						{
							ascii: useAscii,
							appMode: appMode.type,
							spinnerFrame,
							colors: todoColors,
							doneCount: todoPanel.doneCount,
							totalCount: todoPanel.todoItems.length,
						},
						theme,
					)
				: null,
		[
			actualTodoRows,
			innerWidth,
			useAscii,
			appMode.type,
			spinnerFrame,
			todoColors,
			todoPanel.doneCount,
			todoPanel.todoItems.length,
			theme,
		],
	);

	// Memo 2: Remaining body lines — does NOT depend on spinnerFrame
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
					spinnerFrame: '',
					skipHeader: true,
				},
				runOverlay: {actualRunOverlayRows, runSummaries, runFilter: 'all'},
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
			actualRunOverlayRows,
			runSummaries,
			theme,
		],
	);

	const feedCols = useFeedColumns(filteredEntries, innerWidth);

	const {inputPrefix, badgeText, inputContentWidth, textInputPlaceholder} =
		useInputLayout({
			innerWidth,
			inputMode,
			isHarnessRunning,
			lastRunStatus,
			dialogActive,
			dialogType: appMode.type,
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

	// Stable callback for CommandSuggestionPanel — composes frameLine + border edges.
	const wrapFrameLine = useCallback(
		(line: string) => withBorderEdges(frameLine(line)),
		[withBorderEdges, frameLine],
	);

	if (pagerActive) {
		return <Box />;
	}

	return (
		<Box flexDirection="column" width={frameWidth}>
			<Text>{border(topBorder)}</Text>
			<Text>{withBorderEdges(frameLine(headerLine1))}</Text>
			<Text>{border(sectionBorder)}</Text>
			{todoHeaderLine !== null && (
				<Text key="todo-header">
					{withBorderEdges(frameLine(todoHeaderLine))}
				</Text>
			)}
			{prefixBodyLines.map((line, index) => (
				<Text key={`body-${index}`}>{withBorderEdges(frameLine(line))}</Text>
			))}
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
			/>
			<Text>{border(sectionBorder)}</Text>
			{frame.footerHelp !== null && (
				<>
					<Text>
						{withBorderEdges(
							frameLine(
								toastMessage
									? chalk.bold.green(toastMessage)
									: fit(frame.footerHelp, innerWidth),
							),
						)}
					</Text>
					<Text>{withBorderEdges(frameLine(''))}</Text>
				</>
			)}
			<CommandSuggestionPanel
				ref={suggestionPanelRef}
				inputValueRef={inputValueRef}
				isActive={inputMode === 'command'}
				innerWidth={innerWidth}
				wrapLine={wrapFrameLine}
			/>
			<FrameRow
				innerWidth={innerWidth}
				ascii={useAscii}
				borderColor={theme.border}
				height={inputRows}
			>
				<Box width={inputPrefix.length} flexShrink={0}>
					<Text>{inputPromptStyled}</Text>
				</Box>
				<Box width={inputContentWidth} flexShrink={0}>
					<MultiLineInput
						width={inputContentWidth}
						placeholder={textInputPlaceholder}
						textColor={theme.text}
						placeholderColor={inputPlaceholderColor}
						isActive={focusMode === 'input' && !dialogActive}
						onChange={handleInputChange}
						onSubmit={handleInputSubmit}
						onHistoryBack={handleHistoryBack}
						onHistoryForward={handleHistoryForward}
						suppressArrows={inputMode === 'command'}
						setValueRef={handleSetValueRef}
					/>
				</Box>
				<Box width={badgeText.length} flexShrink={0}>
					<Text>{runBadgeStyled + modeBadgeStyled}</Text>
				</Box>
			</FrameRow>
			<Text>{border(bottomBorder)}</Text>
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
	let initialPhase: AppPhase;
	if (showSetup) {
		initialPhase = {type: 'setup'};
	} else if (showSessionPicker) {
		initialPhase = {type: 'session-select'};
	} else {
		initialPhase = {type: 'main', initialSessionId};
	}
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
		<MaybeProfiler
			enabled={perfEnabled}
			id="app.main"
			onRender={handleProfilerRender}
		>
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
						workflowRef={runtimeState.workflowRef}
						workflow={runtimeState.workflow}
						ascii={ascii}
					/>
				</HookProvider>
			</ThemeProvider>
		</MaybeProfiler>
	);
}
