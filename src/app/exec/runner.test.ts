import {describe, it, expect, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import type {ChildProcess} from 'node:child_process';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeDecisionHandler,
	RuntimeEvent,
	RuntimeEventHandler,
} from '../../core/runtime/types';
import {runExec} from './runner';
import {EXEC_EXIT_CODE} from './types';

class MockRuntime implements Runtime {
	private eventHandlers = new Set<RuntimeEventHandler>();
	private decisionHandlers = new Set<RuntimeDecisionHandler>();
	private status: 'stopped' | 'running' = 'stopped';
	public decisions: Array<{eventId: string; decision: RuntimeDecision}> = [];

	start(): Promise<void> {
		this.status = 'running';
		return Promise.resolve();
	}

	stop(): void {
		this.status = 'stopped';
	}

	getStatus(): 'stopped' | 'running' {
		return this.status;
	}

	getLastError() {
		return null;
	}

	onEvent(handler: RuntimeEventHandler): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	onDecision(handler: RuntimeDecisionHandler): () => void {
		this.decisionHandlers.add(handler);
		return () => this.decisionHandlers.delete(handler);
	}

	sendDecision(eventId: string, decision: RuntimeDecision): void {
		this.decisions.push({eventId, decision});
		for (const handler of this.decisionHandlers) {
			handler(eventId, decision);
		}
	}

	emit(event: RuntimeEvent): void {
		for (const handler of this.eventHandlers) {
			handler(event);
		}
	}
}

type SpawnArgs = Parameters<
	NonNullable<Parameters<typeof runExec>[0]['spawnProcess']>
>[0];

function makeRuntimeEvent(partial: Partial<RuntimeEvent>): RuntimeEvent {
	return {
		id: partial.id ?? 'evt-1',
		timestamp: partial.timestamp ?? Date.now(),
		kind: partial.kind ?? 'notification',
		data: partial.data ?? {},
		hookName: partial.hookName ?? 'Notification',
		sessionId: partial.sessionId ?? 'adapter-session',
		toolName: partial.toolName,
		toolUseId: partial.toolUseId,
		agentId: partial.agentId,
		agentType: partial.agentType,
		context: partial.context ?? {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: partial.interaction ?? {expectsDecision: false},
		payload: partial.payload ?? {},
	};
}

function makeChildProcess(onKill?: () => void): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	child.kill = vi.fn().mockImplementation(() => {
		onKill?.();
		return true;
	});
	return child;
}

function createWriteCapture() {
	let value = '';
	return {
		writer: {
			write(chunk: string) {
				value += chunk;
			},
		},
		read: () => value,
	};
}

describe('runExec', () => {
	it('returns success and prints final message in human mode', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({kind: 'session.start', hookName: 'SessionStart'}),
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'fail',
			onQuestion: 'fail',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(true);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.SUCCESS);
		expect(result.finalMessage).toBe('done message');
		expect(stdout.read()).toContain('done message');
		expect(stderr.read()).not.toContain('error');
	});

	it('fails with policy exit code when permission policy is fail', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash'},
					}),
				);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'fail',
			onQuestion: 'fail',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.POLICY);
		expect(result.failure?.kind).toBe('policy');
		expect(runtime.decisions.length).toBe(0);
		expect(stderr.read()).toContain('error');
	});

	it('auto-answers AskUserQuestion in empty mode', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'ask-1',
						kind: 'tool.pre',
						hookName: 'PreToolUse',
						toolName: 'AskUserQuestion',
						interaction: {expectsDecision: true},
						data: {
							tool_name: 'AskUserQuestion',
							tool_input: {},
						},
					}),
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'answered'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'fail',
			onQuestion: 'empty',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(true);
		expect(runtime.decisions).toContainEqual(
			expect.objectContaining({
				eventId: 'ask-1',
				decision: expect.objectContaining({
					intent: {kind: 'question_answer', answers: {}},
				}),
			}),
		);
	});

	it('fails with policy exit code when AskUserQuestion is configured to fail', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'ask-fail',
						kind: 'tool.pre',
						hookName: 'PreToolUse',
						toolName: undefined,
						interaction: {expectsDecision: true},
						data: {
							tool_name: 'AskUserQuestion',
							tool_input: {},
						},
					}),
				);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'fail',
			onQuestion: 'fail',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.POLICY);
		expect(result.failure?.kind).toBe('policy');
		expect(runtime.decisions.length).toBe(0);
		expect(stderr.read()).toContain(
			'AskUserQuestion interaction requires input',
		);
	});

	it('applies on-permission=allow policy to permission requests', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'perm-1',
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash'},
					}),
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'permission handled'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'allow',
			onQuestion: 'fail',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(true);
		expect(runtime.decisions).toContainEqual(
			expect.objectContaining({
				eventId: 'perm-1',
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
			}),
		);
	});

	it('returns timeout exit code when execution exceeds timeout', async () => {
		vi.useFakeTimers();
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});
			return child;
		};

		try {
			const runPromise = runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				onPermission: 'fail',
				onQuestion: 'fail',
				timeoutMs: 10,
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
			});

			await vi.advanceTimersByTimeAsync(20);
			const result = await runPromise;

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.TIMEOUT);
			expect(result.failure?.kind).toBe('timeout');
			expect(stderr.read()).toContain('timed out');
		} finally {
			vi.useRealTimers();
		}
	});

	it('removes the tracker file when a workflow loop reaches a terminal state', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/tracker.md';
		fs.writeFileSync(trackerPath, '<!-- DONE -->', 'utf-8');

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'done message'}],
					}) + '\n',
				);
				opts.onExit?.(0);
			});

			return child;
		};

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				onPermission: 'fail',
				onQuestion: 'fail',
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
				workflow: {
					name: 'test-loop',
					plugins: [],
					promptTemplate: '{input}',
					loop: {
						enabled: true,
						completionMarker: '<!-- DONE -->',
						maxIterations: 5,
						trackerPath: 'tracker.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(fs.existsSync(trackerPath)).toBe(false);
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	it('returns runtime failure when session store initialization throws', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'fail',
			onQuestion: 'fail',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess: () => makeChildProcess(),
			sessionStoreFactory: () => {
				throw new Error('db init failed');
			},
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toContain('db init failed');
	});

	it('returns runtime failure when runtime initialization throws', async () => {
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			onPermission: 'fail',
			onQuestion: 'fail',
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => {
				throw new Error('runtime init failed');
			},
			spawnProcess: () => makeChildProcess(),
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toContain('runtime init failed');
	});
});
