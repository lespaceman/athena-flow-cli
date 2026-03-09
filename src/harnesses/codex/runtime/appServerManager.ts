import {spawn, type ChildProcess} from 'node:child_process';
import {
	createInterface,
	type Interface as ReadlineInterface,
} from 'node:readline';
import {EventEmitter} from 'node:events';
import {
	type JsonRpcRequest,
	type JsonRpcResponse,
	type JsonRpcNotification,
	type JsonRpcServerRequest,
	isResponse,
	isNotification,
	isServerRequest,
} from '../protocol/jsonrpc.js';

const REQUEST_TIMEOUT_MS = 20_000;

export type AppServerManagerEvents = {
	notification: [JsonRpcNotification];
	serverRequest: [JsonRpcServerRequest];
	error: [Error];
	exit: [number | null, NodeJS.Signals | null];
	ready: [];
};

type PendingRequest = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class AppServerManager extends EventEmitter<AppServerManagerEvents> {
	private process: ChildProcess | null = null;
	private readline: ReadlineInterface | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private _ready = false;

	constructor(
		private readonly binaryPath: string = 'codex',
		private readonly cwd?: string,
		private readonly env?: Record<string, string>,
	) {
		super();
	}

	get isRunning(): boolean {
		return this.process !== null && !this.process.killed;
	}

	get ready(): boolean {
		return this._ready;
	}

	async start(): Promise<void> {
		if (this.process) return;

		const childEnv = {...process.env, ...this.env};
		this.process = spawn(this.binaryPath, ['app-server'], {
			cwd: this.cwd,
			env: childEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		this.process.on('error', err => this.emit('error', err));
		this.process.on('exit', (code, signal) => {
			this._ready = false;
			this.rejectAllPending('Process exited');
			this.emit('exit', code, signal);
		});

		this.process.stderr?.on('data', (chunk: Buffer) => {
			const line = chunk.toString().trim();
			if (line && !this.isBenignStderr(line)) {
				this.emit('error', new Error(`[codex stderr] ${line}`));
			}
		});

		this.readline = createInterface({input: this.process.stdout!});
		this.readline.on('line', (line: string) => this.handleLine(line));

		await this.sendRequest('initialize', {
			clientInfo: {
				name: 'athena-cli',
				title: 'Athena CLI',
				version: '0.1.0',
			},
		});
		this.sendNotification('initialized');
		this._ready = true;
		this.emit('ready');
	}

	async stop(): Promise<void> {
		this.rejectAllPending('Manager stopped');
		this.readline?.close();
		this.readline = null;

		if (this.process && !this.process.killed) {
			this.process.kill('SIGTERM');
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => {
					if (this.process && !this.process.killed) {
						this.process.kill('SIGKILL');
					}
					resolve();
				}, 3000);
				this.process!.on('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		this.process = null;
		this._ready = false;
	}

	sendRequest(
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin?.writable) {
				reject(new Error('Process not running'));
				return;
			}

			const id = this.nextId++;
			const msg: JsonRpcRequest = {method, id, ...(params && {params})};

			const timer = setTimeout(() => {
				const p = this.pending.get(id);
				if (p) {
					this.pending.delete(id);
					p.reject(new Error(`Request ${method} (id=${id}) timed out`));
				}
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(id, {resolve, reject, timer});
			this.process.stdin.write(JSON.stringify(msg) + '\n');
		});
	}

	sendNotification(method: string, params?: Record<string, unknown>): void {
		if (!this.process?.stdin?.writable) return;
		const msg = {method, ...(params && {params})};
		this.process.stdin.write(JSON.stringify(msg) + '\n');
	}

	respondToServerRequest(id: number, result: unknown): void {
		if (!this.process?.stdin?.writable) return;
		const msg: JsonRpcResponse = {id, result};
		this.process.stdin.write(JSON.stringify(msg) + '\n');
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			return;
		}

		if (isResponse(parsed)) {
			const p = this.pending.get(parsed.id);
			if (p) {
				clearTimeout(p.timer);
				this.pending.delete(parsed.id);
				if (parsed.error) {
					p.reject(
						new Error(`${parsed.error.message} (code=${parsed.error.code})`),
					);
				} else {
					p.resolve(parsed.result);
				}
			}
			return;
		}

		if (isServerRequest(parsed)) {
			this.emit('serverRequest', parsed as JsonRpcServerRequest);
			return;
		}

		if (isNotification(parsed)) {
			this.emit('notification', parsed as JsonRpcNotification);
			return;
		}
	}

	private isBenignStderr(line: string): boolean {
		// Filter noisy but harmless log lines from codex app-server
		return (
			line.startsWith('RUST_LOG') ||
			line.startsWith('DEBUG') ||
			line.startsWith('TRACE') ||
			line.includes('tracing_subscriber') ||
			line.length === 0
		);
	}

	private rejectAllPending(reason: string): void {
		for (const [_id, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error(reason));
		}
		this.pending.clear();
	}
}
