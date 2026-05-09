import {describe, it, expect, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ChildProcess} from 'node:child_process';
import type {
	Runtime,
	RuntimeDecision,
	RuntimeDecisionHandler,
	RuntimeEvent,
	RuntimeEventHandler,
} from '../../core/runtime/types';
import type {SessionBridge} from '../channels/sessionBridge';
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

type FakeBridge = Pick<
	SessionBridge,
	'relayPermission' | 'relayQuestion' | 'stop'
>;

function makeFakeBridge(overrides: Partial<FakeBridge> = {}): SessionBridge {
	const defaults: FakeBridge = {
		relayPermission: vi.fn().mockResolvedValue({
			channelRequestId: 'chan-1',
			result: {
				kind: 'verdict',
				channelId: 'telegram',
				behavior: 'allow',
			},
		}),
		relayQuestion: vi.fn().mockResolvedValue({
			channelRequestId: 'chan-q-1',
			result: {kind: 'no_relay'},
		}),
		stop: vi.fn().mockResolvedValue(undefined),
	};
	return {...defaults, ...overrides} as unknown as SessionBridge;
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

	it('cancels via abort signal while a permission request is pending and returns runtime exit code', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const abortController = new AbortController();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess(() => {
				opts.onExit?.(null);
			});

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'perm-cancel',
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash'},
					}),
				);
				setImmediate(() => abortController.abort());
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
			signal: abortController.signal,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(result.failure?.kind).toBe('process');
		expect(result.failure?.message).toBe('Execution cancelled.');
		expect(runtime.decisions.length).toBe(0);
	});

	it('times out waiting for a pending permission decision when no bridge is attached', async () => {
		vi.useFakeTimers();
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
						id: 'perm-timeout',
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

		try {
			const runPromise = runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
				timeoutMs: 50,
				ephemeral: true,
				stdout: stdout.writer,
				stderr: stderr.writer,
				runtimeFactory: () => runtime,
				spawnProcess,
			});

			await vi.advanceTimersByTimeAsync(60);
			const result = await runPromise;

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.TIMEOUT);
			expect(result.failure?.kind).toBe('timeout');
			expect(runtime.decisions.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('relays a permission request through the bridge and applies the verdict', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const bridge = makeFakeBridge();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				runtime.emit(
					makeRuntimeEvent({
						id: 'perm-bridge',
						kind: 'permission.request',
						hookName: 'PermissionRequest',
						toolName: 'Bash',
						interaction: {expectsDecision: true},
						data: {tool_name: 'Bash', tool_input: {command: 'pwd'}},
					}),
				);
				setImmediate(() => {
					opts.onStdout?.(
						JSON.stringify({
							type: 'message',
							role: 'assistant',
							content: [{type: 'text', text: 'permission granted'}],
						}) + '\n',
					);
					opts.onExit?.(0);
				});
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			channels: ['telegram'],
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
			bridgeFactory: () => Promise.resolve(bridge),
		});

		expect(result.success).toBe(true);
		expect(bridge.relayPermission).toHaveBeenCalledWith(
			expect.objectContaining({toolName: 'Bash'}),
		);
		expect(bridge.stop).toHaveBeenCalledTimes(1);
		expect(runtime.decisions).toContainEqual(
			expect.objectContaining({
				eventId: 'perm-bridge',
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

	it('preserves the tracker file when a workflow loop reaches a terminal state', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const projectDir = '/tmp/runner-terminal-project';
		const trackerPath = `${projectDir}/.athena/session-1.md`;
		fs.mkdirSync(`${projectDir}/.athena`, {recursive: true});
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
				projectDir,
				harness: 'claude-code',
				athenaSessionId: 'session-1',
				isolationConfig: {},
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
						trackerPath: '.athena/{sessionId}.md',
					},
				},
			});

			expect(result.success).toBe(true);
			expect(fs.existsSync(trackerPath)).toBe(true);
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	it('fails when a looped workflow exhausts iterations without completion', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-test-'));
		const trackerPath = path.join(projectDir, 'tracker.md');

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				// Simulate the agent replacing the skeleton with real content but
				// never writing the completion marker, so the loop runs to its
				// iteration cap.
				fs.writeFileSync(trackerPath, 'work in progress', 'utf-8');
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
				projectDir,
				harness: 'claude-code',
				isolationConfig: {},
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

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.WORKFLOW_EXHAUSTED);
			expect(result.failure?.kind).toBe('workflow');
			expect(result.failure).toEqual(
				expect.objectContaining({
					kind: 'workflow',
					state: 'exhausted',
				}),
			);
			expect(result.finalMessage).toBeNull();
		} finally {
			fs.rmSync(projectDir, {recursive: true, force: true});
		}
	});

	it('fails when a looped workflow is blocked', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/runner-blocked-tracker.md';

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				fs.writeFileSync(
					trackerPath,
					'<!-- E2E_BLOCKED: browser initialization failed -->',
					'utf-8',
				);
				opts.onStdout?.(
					JSON.stringify({
						type: 'message',
						role: 'assistant',
						content: [{type: 'text', text: 'blocked'}],
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
						blockedMarker: '<!-- E2E_BLOCKED',
						maxIterations: 5,
						trackerPath: 'runner-blocked-tracker.md',
					},
				},
			});

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.WORKFLOW_BLOCKED);
			expect(result.failure?.kind).toBe('workflow');
			expect(result.failure).toEqual(
				expect.objectContaining({
					kind: 'workflow',
					state: 'blocked',
				}),
			);
			expect(result.failure?.message).toContain('Workflow blocked');
			expect(result.finalMessage).toBeNull();
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	it('fails when maxIterations is exhausted', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();
		const trackerPath = '/tmp/runner-max-iterations-tracker.md';

		const spawnProcess = vi.fn((opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				fs.writeFileSync(trackerPath, 'still running', 'utf-8');
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
		});

		try {
			const result = await runExec({
				prompt: 'hello',
				projectDir: '/tmp',
				harness: 'claude-code',
				isolationConfig: {},
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
						maxIterations: 1,
						trackerPath: 'runner-max-iterations-tracker.md',
					},
				},
			});

			expect(result.success).toBe(false);
			expect(result.exitCode).toBe(EXEC_EXIT_CODE.WORKFLOW_EXHAUSTED);
			expect(result.failure?.kind).toBe('workflow');
			expect(result.failure).toEqual(
				expect.objectContaining({
					kind: 'workflow',
					state: 'exhausted',
				}),
			);
			expect(result.failure?.message).toContain('maximum of 1 iterations');
			expect(result.finalMessage).toBeNull();
			expect(spawnProcess).toHaveBeenCalledTimes(1);
		} finally {
			fs.rmSync(trackerPath, {force: true});
		}
	});

	it('surfaces stderr in failure message when process exits non-zero', async () => {
		const runtime = new MockRuntime();
		const stdout = createWriteCapture();
		const stderr = createWriteCapture();

		const spawnProcess = (opts: SpawnArgs): ChildProcess => {
			const child = makeChildProcess();

			setImmediate(() => {
				opts.onStderr?.('Authentication failed: invalid API key');
				opts.onStderr?.('Hook cancelled');
				opts.onExit?.(1);
			});

			return child;
		};

		const result = await runExec({
			prompt: 'hello',
			projectDir: '/tmp',
			harness: 'claude-code',
			isolationConfig: {},
			ephemeral: true,
			stdout: stdout.writer,
			stderr: stderr.writer,
			runtimeFactory: () => runtime,
			spawnProcess,
		});

		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(result.failure?.message).toContain('exited with code 1');
		expect(result.failure?.message).toContain('Authentication failed');
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
