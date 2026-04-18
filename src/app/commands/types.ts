/**
 * Command system types.
 *
 * Defines the command type hierarchy using discriminated unions on the
 * `category` field. Each category has its own execution interface.
 */

import {type Message} from '../../shared/types/common';
import {type IsolationConfig} from '../../harnesses/claude/config/isolation';
import {type UseFeedResult} from '../providers/useFeed';
import {type SessionStatsSnapshot} from '../../shared/types/headerMetrics';

// ---------------------------------------------------------------------------
// Core command types
// ---------------------------------------------------------------------------

export type CommandCategory = 'ui' | 'prompt' | 'hook';
export type SessionStrategy = 'new' | 'resume';

export type CommandArg = {
	name: string;
	description: string;
	required: boolean;
};

type CommandBase = {
	name: string;
	description: string;
	category: CommandCategory;
	aliases?: string[];
	args?: CommandArg[];
};

export type UICommand = CommandBase & {
	category: 'ui';
	execute: (ctx: UICommandContext) => void;
};

export type PromptCommand = CommandBase & {
	category: 'prompt';
	session: SessionStrategy;
	isolation?: Partial<IsolationConfig>;
	buildPrompt: (args: Record<string, string>) => string;
};

export type HookCommand = CommandBase & {
	category: 'hook';
	execute: (ctx: HookCommandContext) => void;
};

export type Command = UICommand | PromptCommand | HookCommand;

// ---------------------------------------------------------------------------
// Execution contexts
// ---------------------------------------------------------------------------

export type UICommandContext = {
	args: Record<string, string>;
	messages: Message[];
	setMessages: (msgs: Message[]) => void;
	addMessage: (msg: Omit<Message, 'seq'>) => void;
	exit: () => void;
	clearScreen: () => void;
	showSessions: () => void;
	showSetup: () => void;
	showWorkflowPicker: () => void;
	showModelPicker: () => void;
	sessionStats: SessionStatsSnapshot;
};

export type HookCommandContext = {
	args: Record<string, string>;
	feed: HookCommandFeed;
};

export type HookCommandFeed = Pick<
	UseFeedResult,
	'printTaskSnapshot' | 'emitNotification'
>;

export type PromptCommandContext = {
	spawn: (
		prompt: string,
		sessionId?: string,
		isolation?: Partial<IsolationConfig>,
	) => Promise<void>;
	currentSessionId: string | undefined;
};

export type ExecuteCommandContext = {
	ui: UICommandContext;
	hook: HookCommandContext;
	prompt: PromptCommandContext;
};
