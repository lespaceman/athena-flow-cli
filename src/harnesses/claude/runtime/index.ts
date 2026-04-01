/**
 * Claude Hook Runtime Adapter.
 *
 * Factory that creates a Runtime instance backed by UDS + NDJSON protocol.
 * Also accepts stream-json stdout data for tool result streaming.
 */

import type {Runtime} from '../../../core/runtime/types';
import {createServer} from './server';

export type ClaudeHookRuntimeOptions = {
	projectDir: string;
	instanceId: number;
};

/**
 * Extended runtime that accepts Claude Code's stream-json stdout.
 * The core Runtime interface stays harness-neutral; this extension
 * is only used within the Claude harness adapter.
 */
export type ClaudeRuntime = Runtime & {
	feedStdout(chunk: string): void;
};

export function createClaudeHookRuntime(
	opts: ClaudeHookRuntimeOptions,
): ClaudeRuntime {
	return createServer(opts);
}
