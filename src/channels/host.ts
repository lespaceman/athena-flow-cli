/**
 * ChannelHost: manages a single channel subprocess.
 *
 * Spawns Node with the channel's entry script, frames stdio as NDJSON,
 * dispatches inbound `ChannelEventMessage`s to a handler, and accepts
 * `ChannelMethodMessage`s for outbound delivery.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import process from 'node:process';
import {encodeLine, LineReader, parseEventMessage} from './protocol';
import type {
	ChannelDefinition,
	ChannelEventMessage,
	ChannelMethodMessage,
} from './types';

export type ChannelHostHandlers = {
	onEvent: (event: ChannelEventMessage) => void;
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	onError: (message: string) => void;
};

export class ChannelHost {
	readonly definition: ChannelDefinition;
	private child: ChildProcess | null = null;
	private reader = new LineReader();
	private stderrReader = new LineReader();
	private handlers: ChannelHostHandlers;
	private started = false;
	private disposed = false;

	constructor(definition: ChannelDefinition, handlers: ChannelHostHandlers) {
		this.definition = definition;
		this.handlers = handlers;
	}

	get name(): string {
		return this.definition.name;
	}

	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		const args = this.definition.args ?? [this.definition.entryPath];
		this.child = spawn(process.execPath, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: process.env,
		});
		this.child.on('error', err => {
			this.handlers.onError(`spawn error: ${err.message}`);
		});
		// Without this listener, an EPIPE during write becomes an
		// uncaughtException and would crash the host process.
		this.child.stdin?.on('error', err => {
			this.handlers.onError(`stdin error: ${err.message}`);
		});
		this.child.stdout?.on('data', chunk => {
			for (const line of this.reader.push(chunk as Buffer)) {
				this.dispatchLine(line);
			}
		});
		this.child.stderr?.on('data', chunk => {
			for (const line of this.stderrReader.push(chunk as Buffer)) {
				this.handlers.onError(line);
			}
		});
		this.child.on('exit', (code, signal) => {
			// Surface any trailing partial stderr line — most diagnostically
			// valuable on crashes that don't terminate output with \n.
			for (const line of this.stderrReader.flush()) {
				this.handlers.onError(line);
			}
			this.child = null;
			this.handlers.onExit(code, signal);
		});

		this.send({
			session_id: 'legacy',
			method: 'init',
			params: {
				allowed_user_ids: this.definition.allowedUserIds,
				options: this.definition.options ?? {},
			},
		});
	}

	send(message: ChannelMethodMessage): void {
		if (!this.child || !this.child.stdin || this.child.stdin.destroyed) return;
		try {
			this.child.stdin.write(encodeLine(message));
		} catch (err) {
			this.handlers.onError(
				`stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const child = this.child;
		if (!child) return;
		try {
			this.send({session_id: 'legacy', method: 'shutdown', params: {}});
		} catch {
			// ignore
		}
		// Drop data listeners so late stdout/stderr chunks don't keep
		// re-entering parsing during the SIGTERM window.
		child.stdout?.removeAllListeners('data');
		child.stderr?.removeAllListeners('data');
		const killTimer = setTimeout(() => {
			if (!child.killed) child.kill('SIGTERM');
		}, 1000);
		child.once('exit', () => clearTimeout(killTimer));
	}

	private dispatchLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.handlers.onError(`invalid JSON line: ${truncate(line, 200)}`);
			return;
		}
		const result = parseEventMessage(parsed);
		if (!result.ok) {
			this.handlers.onError(`invalid event: ${result.reason}`);
			return;
		}
		try {
			this.handlers.onEvent(result.value);
		} catch (err) {
			this.handlers.onError(
				`event handler threw: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '…' : s;
}
