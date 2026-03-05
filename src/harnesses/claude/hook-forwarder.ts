#!/usr/bin/env node
/**
 * Hook Forwarder - Standalone script invoked by Claude Code hooks
 *
 * Flow:
 * 1. Receives hook input JSON via stdin from Claude Code
 * 2. Connects to Ink CLI via Unix Domain Socket
 * 3. Sends hook_event message
 * 4. Waits for hook_result response
 * 5. Returns result via stdout/stderr + exit code to Claude Code
 *
 * Exit codes:
 * - 0: passthrough or json_output (with stdout JSON)
 * - 2: block_with_stderr (with stderr message)
 */

import * as net from 'node:net';
import * as path from 'node:path';

import {
	type ClaudeHookEvent,
	type HookEventEnvelope,
	type HookResultEnvelope,
	generateId,
} from './protocol/index';

const SOCKET_TIMEOUT_MS = 5000; // 5 seconds - generous buffer for busy UI
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for permission decisions

function getSocketPath(cwd: string): string {
	const instanceId = process.env['ATHENA_INSTANCE_ID'];
	const socketFilename = instanceId ? `ink-${instanceId}.sock` : 'ink.sock';
	// Use cwd from hook payload - this is the project directory where athena-cli is running
	return path.join(cwd, '.claude', 'run', socketFilename);
}

async function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk: string) => {
			data += chunk;
		});
		process.stdin.on('end', () => {
			resolve(data);
		});
		process.stdin.on('error', reject);
	});
}

type ConnectResult = {
	envelope: HookResultEnvelope | null;
	error?: 'ENOENT' | 'ECONNREFUSED' | 'TIMEOUT' | 'UNKNOWN';
};

async function connectAndSend(
	socketPath: string,
	envelope: HookEventEnvelope,
	timeoutMs: number,
): Promise<ConnectResult> {
	return new Promise(resolve => {
		const socket = new net.Socket();
		let responseData = '';
		let resolved = false;

		const cleanup = (error?: ConnectResult['error']) => {
			if (!resolved) {
				resolved = true;
				socket.destroy();
				resolve({envelope: null, error});
			}
		};

		// Set timeout for entire operation
		const timeoutId = setTimeout(() => cleanup('TIMEOUT'), timeoutMs);

		socket.on('connect', () => {
			// Send the envelope as NDJSON (newline-delimited JSON)
			socket.write(JSON.stringify(envelope) + '\n');
		});

		socket.on('data', (chunk: Buffer) => {
			responseData += chunk.toString();
			// Check for newline (NDJSON delimiter)
			const lines = responseData.split('\n');
			if (lines.length > 1 && lines[0]) {
				clearTimeout(timeoutId);
				resolved = true;
				socket.destroy();
				try {
					const result = JSON.parse(lines[0]) as HookResultEnvelope;
					resolve({envelope: result});
				} catch {
					resolve({envelope: null, error: 'UNKNOWN'});
				}
			}
		});

		socket.on('error', (err: NodeJS.ErrnoException) => {
			clearTimeout(timeoutId);
			if (err.code === 'ENOENT') {
				cleanup('ENOENT');
			} else if (err.code === 'ECONNREFUSED') {
				cleanup('ECONNREFUSED');
			} else {
				cleanup('UNKNOWN');
			}
		});

		socket.on('close', () => {
			clearTimeout(timeoutId);
			if (!resolved) {
				resolved = true;
				resolve({envelope: null});
			}
		});

		// Connect to the socket
		socket.connect(socketPath);
	});
}

async function main(): Promise<void> {
	try {
		// Read stdin
		const stdinData = await readStdin();
		if (!stdinData.trim()) {
			// No input, passthrough
			process.exit(0);
		}

		// Parse hook input from Claude Code
		let hookInput: ClaudeHookEvent;
		try {
			hookInput = JSON.parse(stdinData) as ClaudeHookEvent;
		} catch {
			// Invalid JSON, passthrough
			process.exit(0);
		}

		// Build the envelope
		const requestId = generateId();
		const envelope: HookEventEnvelope = {
			request_id: requestId,
			ts: Date.now(),
			session_id: hookInput.session_id,
			hook_event_name: hookInput.hook_event_name,
			payload: hookInput,
		};

		// Connect to Ink CLI and send
		// Use extended timeout for PreToolUse and PermissionRequest events (permission/question dialog may be shown)
		const timeoutMs =
			hookInput.hook_event_name === 'PreToolUse' ||
			hookInput.hook_event_name === 'PermissionRequest'
				? PERMISSION_TIMEOUT_MS
				: SOCKET_TIMEOUT_MS;

		// Use cwd from hook input - this is set by Claude to the project directory
		const socketPath = getSocketPath(hookInput.cwd);
		const {envelope: result, error} = await connectAndSend(
			socketPath,
			envelope,
			timeoutMs,
		);

		// Handle connection errors with informative messages (to stderr, still passthrough)
		if (error === 'ENOENT') {
			// Socket doesn't exist - CLI not running
			process.stderr.write(
				`[hook-forwarder] Ink CLI not running (socket not found: ${socketPath})\n`,
			);
			process.exit(0); // Passthrough to avoid blocking Claude Code
		}

		if (error === 'ECONNREFUSED') {
			// Socket exists but nothing listening - stale socket
			process.stderr.write(
				`[hook-forwarder] Ink CLI not responding (stale socket: ${socketPath})\n`,
			);
			process.exit(0); // Passthrough
		}

		// Handle result
		if (!result || result.payload.action === 'passthrough') {
			// Passthrough: exit 0, no output
			process.exit(0);
		}

		if (result.payload.action === 'block_with_stderr') {
			// Block: exit 2, stderr message
			process.stderr.write(result.payload.stderr ?? 'Blocked by Ink CLI');
			process.exit(2);
		}

		// JSON output: exit 0, stdout JSON
		if (result.payload.stdout_json) {
			process.stdout.write(JSON.stringify(result.payload.stdout_json));
		}
		process.exit(0);
	} catch {
		// Any error, passthrough to avoid blocking Claude Code
		process.exit(0);
	}
}

main();
