import type {RuntimeEvent} from '../../../core/runtime/types';
import type {RuntimeEventKind} from '../../../core/runtime/events';

type InteractionHints = RuntimeEvent['interaction'];

const DEFAULT_TIMEOUT_MS = 4000;
const PERMISSION_TIMEOUT_MS = 300_000;

const DEFAULT_HINTS: InteractionHints = {
	expectsDecision: false,
	defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
	canBlock: false,
};

const RULES: Record<RuntimeEventKind, InteractionHints> = {
	'permission.request': {
		expectsDecision: true,
		defaultTimeoutMs: PERMISSION_TIMEOUT_MS,
		canBlock: true,
	},
	'tool.pre': {
		expectsDecision: true,
		defaultTimeoutMs: PERMISSION_TIMEOUT_MS,
		canBlock: true,
	},
	'tool.post': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'tool.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'tool.failure': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'stop.request': {
		expectsDecision: true,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'subagent.stop': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'subagent.start': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	notification: {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'session.start': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'session.end': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'compact.pre': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'user.prompt': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'turn.start': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'turn.complete': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'message.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'message.complete': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'plan.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'reasoning.delta': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'usage.update': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	setup: {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: false,
	},
	'teammate.idle': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'task.completed': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	'config.change': {
		expectsDecision: false,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		canBlock: true,
	},
	unknown: DEFAULT_HINTS,
};

export function getInteractionHints(kind: string): InteractionHints {
	const maybeRule = (RULES as Partial<Record<string, InteractionHints>>)[kind];
	return maybeRule ?? DEFAULT_HINTS;
}
