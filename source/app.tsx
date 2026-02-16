import process from 'node:process';
import React, {useState, useCallback, useRef, useEffect, useMemo} from 'react';
import {Box, Static, Text, useApp, useInput, useStdout} from 'ink';
import Message from './components/Message.js';
import CommandInput from './components/CommandInput.js';
import PermissionDialog from './components/PermissionDialog.js';
import QuestionDialog from './components/QuestionDialog.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import HookEvent from './components/HookEvent.js';
import TaskList from './components/TaskList.js';
import StreamingResponse from './components/StreamingResponse.js';

import StatsPanel from './components/Header/StatsPanel.js';
import Header from './components/Header/Header.js';
import {HookProvider, useHookContext} from './context/HookContext.js';
import {useClaudeProcess} from './hooks/useClaudeProcess.js';
import {useHeaderMetrics} from './hooks/useHeaderMetrics.js';
import {useDuration} from './hooks/useDuration.js';
import {useSpinner} from './hooks/useSpinner.js';
import {appModeToClaudeState} from './types/headerMetrics.js';
import {useAppMode} from './hooks/useAppMode.js';
import {type InputHistory, useInputHistory} from './hooks/useInputHistory.js';
import {
	type Message as MessageType,
	type IsolationConfig,
	generateId,
} from './types/index.js';
import {
	type ContentItem,
	useContentOrdering,
} from './hooks/useContentOrdering.js';
import {type PermissionDecision} from './types/server.js';
import {parseInput} from './commands/parser.js';
import {executeCommand} from './commands/executor.js';
import {ThemeProvider, useTheme, type Theme} from './theme/index.js';
import SessionPicker from './components/SessionPicker.js';
import {readSessionIndex} from './utils/sessionIndex.js';

type Props = {
	projectDir: string;
	instanceId: number;
	isolation?: IsolationConfig;
	verbose?: boolean;
	version: string;
	pluginMcpConfig?: string;
	modelName: string | null;
	claudeCodeVersion: string | null;
	theme: Theme;
	initialSessionId?: string;
	showSessionPicker?: boolean;
};

type AppPhase =
	| {type: 'session-select'}
	| {type: 'main'; initialSessionId?: string};

function renderContentItem(
	item: ContentItem,
	verbose?: boolean,
): React.ReactNode {
	if (item.type === 'message') {
		return <Message key={item.data.id} message={item.data} />;
	}
	return (
		<ErrorBoundary
			key={item.data.id}
			fallback={<Text color="red">[Error rendering event]</Text>}
		>
			<HookEvent event={item.data} verbose={verbose} />
		</ErrorBoundary>
	);
}

/** Fallback for crashed PermissionDialog — lets user press Escape to deny. */
function PermissionErrorFallback({onDeny}: {onDeny: () => void}) {
	const theme = useTheme();
	useInput((_input, key) => {
		if (key.escape) onDeny();
	});
	return (
		<Text color={theme.status.error}>
			[Permission dialog error — press Escape to deny and continue]
		</Text>
	);
}

/** Fallback for crashed QuestionDialog — lets user press Escape to skip. */
function QuestionErrorFallback({onSkip}: {onSkip: () => void}) {
	const theme = useTheme();
	useInput((_input, key) => {
		if (key.escape) onSkip();
	});
	return (
		<Text color={theme.status.error}>
			[Question dialog error — press Escape to skip and continue]
		</Text>
	);
}

function AppContent({
	projectDir,
	instanceId,
	isolation,
	verbose,
	version,
	pluginMcpConfig,
	modelName,
	initialSessionId,
	onClear,
	onShowSessions,
	inputHistory,
}: Omit<Props, 'claudeCodeVersion' | 'showSessionPicker' | 'theme'> & {
	initialSessionId?: string;
	onClear: () => void;
	onShowSessions: () => void;
	inputHistory: InputHistory;
}) {
	const [messages, setMessages] = useState<MessageType[]>([]);
	const [taskListCollapsed, setTaskListCollapsed] = useState(false);
	const toggleTaskList = useCallback(() => {
		setTaskListCollapsed(c => !c);
	}, []);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const hookServer = useHookContext();
	const {
		events,
		isServerRunning,
		socketPath,
		currentSessionId,
		currentPermissionRequest,
		permissionQueueCount,
		resolvePermission,
		currentQuestionRequest,
		questionQueueCount,
		resolveQuestion,
	} = hookServer;
	const {
		spawn: spawnClaude,
		isRunning: isClaudeRunning,
		sendInterrupt,
		streamingText,
		tokenUsage,
	} = useClaudeProcess(
		projectDir,
		instanceId,
		isolation,
		pluginMcpConfig,
		verbose,
	);
	const {exit} = useApp();

	// Auto-spawn Claude when resuming a session
	const autoSpawnedRef = useRef(false);
	useEffect(() => {
		if (initialSessionId && !autoSpawnedRef.current) {
			autoSpawnedRef.current = true;
			spawnClaude('', initialSessionId);
		}
	}, [initialSessionId, spawnClaude]);

	const metrics = useHeaderMetrics(events);
	const elapsed = useDuration(metrics.sessionStartTime);

	const addMessage = useCallback(
		(role: 'user' | 'assistant', content: string) => {
			const newMessage: MessageType = {
				id: generateId(),
				role,
				content,
				timestamp: new Date(),
			};
			setMessages(prev => [...prev, newMessage]);
			return newMessage;
		},
		[],
	);

	const clearScreen = useCallback(() => {
		hookServer.clearEvents();
		// ANSI: clear screen + clear scrollback + cursor home
		process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
		// Force full remount so Static re-renders the header
		onClear();
	}, [hookServer, onClear]);

	const handleSubmit = useCallback(
		(value: string) => {
			if (!value.trim()) return;

			inputHistory.push(value);

			const result = parseInput(value);

			if (result.type === 'prompt') {
				addMessage('user', result.text);
				spawnClaude(result.text, currentSessionId ?? undefined);
				return;
			}

			// It's a command
			addMessage('user', value);
			const addMessageObj = (msg: MessageType) =>
				setMessages(prev => [...prev, msg]);
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
				hook: {
					args: result.args,
					hookServer,
				},
				prompt: {
					spawn: spawnClaude,
					currentSessionId: currentSessionId ?? undefined,
				},
			});
		},
		[
			addMessage,
			spawnClaude,
			currentSessionId,
			hookServer,
			exit,
			clearScreen,
			onShowSessions,
			inputHistory,
			metrics,
			modelName,
			tokenUsage,
			elapsed,
		],
	);

	const handlePermissionDecision = useCallback(
		(decision: PermissionDecision) => {
			if (!currentPermissionRequest) return;
			resolvePermission(currentPermissionRequest.id, decision);
		},
		[currentPermissionRequest, resolvePermission],
	);

	const handleQuestionAnswer = useCallback(
		(answers: Record<string, string>) => {
			if (!currentQuestionRequest) return;
			resolveQuestion(currentQuestionRequest.id, answers);
		},
		[currentQuestionRequest, resolveQuestion],
	);

	const handleQuestionSkip = useCallback(() => {
		if (!currentQuestionRequest) return;
		resolveQuestion(currentQuestionRequest.id, {});
	}, [currentQuestionRequest, resolveQuestion]);

	const {staticItems, activeItems, tasks} = useContentOrdering({
		messages,
		events,
	});

	const appMode = useAppMode(
		isClaudeRunning,
		currentPermissionRequest,
		currentQuestionRequest,
	);
	const claudeState = appModeToClaudeState(appMode);
	const dialogActive =
		appMode.type === 'permission' || appMode.type === 'question';
	const spinnerFrame = useSpinner(claudeState === 'working');

	const [statsExpanded, setStatsExpanded] = useState(false);
	const {stdout} = useStdout();
	const terminalWidth = stdout?.columns ?? 80;

	useInput(
		(_input, key) => {
			// Ctrl+E toggles stats panel (avoids Ctrl+S XOFF flow control conflict)
			if (key.ctrl && _input === 'e') {
				setStatsExpanded(prev => !prev);
			}
		},
		{isActive: !dialogActive},
	);

	return (
		<Box flexDirection="column">
			{/* Header temporarily disabled
			<Header
				version={version}
				modelName={metrics.modelName || modelName}
				projectDir={projectDir}
				terminalWidth={terminalWidth}
				claudeState={claudeState}
				spinnerFrame={spinnerFrame}
				toolCallCount={metrics.totalToolCallCount}
				contextSize={tokenUsage.contextSize}
				isServerRunning={isServerRunning}
			/>
			*/}

			{/* Stats panel — toggled with Ctrl+E, shows detailed metrics */}
			{statsExpanded && (
				<StatsPanel
					metrics={{...metrics, tokens: tokenUsage}}
					elapsed={elapsed}
					terminalWidth={terminalWidth}
				/>
			)}

			{/* Settled items — committed to scrollback, never re-rendered */}
			<Static items={staticItems}>
				{item => renderContentItem(item, verbose)}
			</Static>

			{/* Active zone — may still be reordered by incoming PostToolUse results */}
			{activeItems.length > 0 && (
				<Box flexDirection="column">
					{activeItems.map(item => renderContentItem(item, verbose))}
				</Box>
			)}

			{/* Active task list - always dynamic, shows latest state */}
			<TaskList
				tasks={tasks}
				collapsed={taskListCollapsed}
				onToggle={toggleTaskList}
				dialogActive={dialogActive}
			/>

			{verbose && streamingText && (
				<StreamingResponse text={streamingText} isStreaming={isClaudeRunning} />
			)}

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
			<CommandInput
				onSubmit={handleSubmit}
				disabled={dialogActive}
				disabledMessage={
					appMode.type === 'question'
						? 'Waiting for your input...'
						: appMode.type === 'permission'
							? 'Respond to permission request above...'
							: undefined
				}
				onEscape={isClaudeRunning ? sendInterrupt : undefined}
				onArrowUp={inputHistory.back}
				onArrowDown={inputHistory.forward}
			/>
		</Box>
	);
}

export default function App({
	projectDir,
	instanceId,
	isolation,
	verbose,
	version,
	pluginMcpConfig,
	modelName,
	theme,
	initialSessionId,
	showSessionPicker,
}: Props) {
	const [clearCount, setClearCount] = useState(0);
	const inputHistory = useInputHistory(projectDir);

	const initialPhase: AppPhase = showSessionPicker
		? {type: 'session-select'}
		: {type: 'main', initialSessionId};
	const [phase, setPhase] = useState<AppPhase>(initialPhase);

	const handleSessionSelect = useCallback((sessionId: string) => {
		setPhase({type: 'main', initialSessionId: sessionId});
	}, []);

	const handleSessionCancel = useCallback(() => {
		setPhase({type: 'main'});
	}, []);

	const handleShowSessions = useCallback(() => {
		setPhase({type: 'session-select'});
	}, []);

	const sessions = useMemo(
		() => (phase.type === 'session-select' ? readSessionIndex(projectDir) : []),
		[projectDir, phase],
	);

	if (phase.type === 'session-select') {
		return (
			<ErrorBoundary
				fallback={
					<Text color="red">[Session picker error — starting new session]</Text>
				}
			>
				<SessionPicker
					sessions={sessions}
					onSelect={handleSessionSelect}
					onCancel={handleSessionCancel}
				/>
			</ErrorBoundary>
		);
	}

	return (
		<ThemeProvider value={theme}>
			<HookProvider projectDir={projectDir} instanceId={instanceId}>
				<AppContent
					key={clearCount}
					projectDir={projectDir}
					instanceId={instanceId}
					isolation={isolation}
					verbose={verbose}
					version={version}
					pluginMcpConfig={pluginMcpConfig}
					modelName={modelName}
					initialSessionId={phase.initialSessionId}
					onClear={() => setClearCount(c => c + 1)}
					onShowSessions={handleShowSessions}
					inputHistory={inputHistory}
				/>
			</HookProvider>
		</ThemeProvider>
	);
}
