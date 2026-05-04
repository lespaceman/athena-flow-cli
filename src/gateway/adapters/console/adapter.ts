/**
 * In-daemon console channel adapter.
 *
 * Conforms to `ChannelAdapter`. Opens a single outbound WSS connection to a
 * broker service and speaks the transport-neutral `AthenaConsoleFrame`
 * protocol. Inbound rich-client messages are normalized to
 * `NormalizedInbound` and surfaced through `AdapterContext.emitInbound`;
 * runtime replies and permission/question relays travel back to the broker
 * as console frames.
 *
 * Reconnect (with bounded backoff) lives in the lifecycle task K7; this
 * file's `start()` opens a single connection and surfaces a fatal error if
 * it fails.
 */

import {readFileSync} from 'node:fs';
import type {
	AdapterContext,
	AthenaConsoleFrame,
	AthenaConsoleInboundMessageFrame,
	ChannelAdapter,
	ChannelCapabilities,
	NormalizedInbound,
	OutboundMessage,
	PermissionRelayRequest,
	PermissionRelayResult,
	ProbeResult,
	QuestionRelayRequest,
	QuestionRelayResult,
	SendResult,
	StopReason,
} from '../../../shared/gateway-protocol';
import {type ConsoleBrokerClient, createConsoleBrokerClient} from './client';
import type {ConsoleAdapterOptions, ConsoleBrokerClientFactory} from './types';

const CONSOLE_ID = 'console';
const CLIENT_NAME = 'athena-cli';
const CLIENT_VERSION = '0.0.0';

export class ConsoleAdapter implements ChannelAdapter {
	readonly id = CONSOLE_ID;
	readonly capabilities: ChannelCapabilities = {
		chat: true,
		threads: true,
		relayPermission: true,
		relayQuestion: true,
	};

	private readonly opts: ConsoleAdapterOptions;
	private client: ConsoleBrokerClient | null = null;
	private ctx: AdapterContext | null = null;
	private readonly pendingPermissions = new Map<
		string,
		{
			resolve: (result: PermissionRelayResult) => void;
			abortListener: () => void;
			signal: AbortSignal;
		}
	>();
	private readonly pendingQuestions = new Map<
		string,
		{
			questionKeys: string[];
			resolve: (result: QuestionRelayResult) => void;
			abortListener: () => void;
			signal: AbortSignal;
		}
	>();

	constructor(opts: ConsoleAdapterOptions) {
		this.opts = opts;
	}

	async start(ctx: AdapterContext): Promise<void> {
		if (this.client) {
			throw new Error('console adapter already started');
		}
		this.ctx = ctx;
		const pairingToken = resolvePairingToken(this.opts);
		const factory: ConsoleBrokerClientFactory =
			this.opts.brokerClientFactory ??
			(input => createConsoleBrokerClient(input));
		const client = factory({
			brokerUrl: this.opts.brokerUrl,
			pairingToken,
			...(this.opts.tlsCaPath !== undefined
				? {tlsCaPath: this.opts.tlsCaPath}
				: {}),
			log: ctx.log,
		});
		client.onFrame(frame => this.handleInboundFrame(frame));
		client.onReady(() => {
			ctx.emitHealth({at: Date.now(), transportOk: true});
		});
		client.onClose(reason => {
			// Pending relays will not be answered by the next connection — the
			// broker has no replay obligation for this adapter version. Cancel
			// them so awaiting callers don't dangle.
			this.disposePermissions('connection_lost');
			this.disposeQuestions('connection_lost');
			ctx.emitHealth({
				at: Date.now(),
				transportOk: false,
				note: `broker connection closed: ${reason}`,
			});
		});
		await client.connect({
			runnerId: this.opts.runnerId,
			...(this.opts.workspaceId !== undefined
				? {workspaceId: this.opts.workspaceId}
				: {}),
			clientName: CLIENT_NAME,
			clientVersion: CLIENT_VERSION,
		});
		this.client = client;
		ctx.signal.addEventListener('abort', () => {
			this.client?.close('manager abort');
		});
	}

	async stop(_reason: StopReason): Promise<void> {
		this.disposePermissions();
		this.disposeQuestions();
		this.client?.close('shutdown');
		this.client = null;
		this.ctx = null;
	}

	async send(msg: OutboundMessage): Promise<SendResult> {
		const client = this.client;
		if (!client || !client.isReady()) {
			throw new Error('console adapter: send called before broker is ready');
		}
		const messageId = makeOutboundMessageId();
		const frame: AthenaConsoleFrame = {
			kind: 'console.message.out',
			frameId: makeFrameId(),
			sentAt: Date.now(),
			address: {
				runnerId: this.opts.runnerId,
				...(this.opts.workspaceId !== undefined
					? {workspaceId: this.opts.workspaceId}
					: {}),
				...(msg.location.peer?.id !== undefined
					? {userId: msg.location.peer.id}
					: {}),
				...(msg.location.thread?.id !== undefined
					? {threadId: msg.location.thread.id}
					: {}),
			},
			messageId,
			idempotencyKey: msg.idempotencyKey,
			text: msg.text,
		};
		client.sendFrame(frame);
		return {
			providerMessageId: messageId,
			deliveredAt: Date.now(),
		};
	}

	async probe(): Promise<ProbeResult> {
		const ok = this.client?.isReady() ?? false;
		return {
			ok,
			detail: ok ? 'broker connected' : 'broker not connected',
			checkedAt: Date.now(),
		};
	}

	requestPermissionVerdict(
		req: PermissionRelayRequest,
		signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		const client = this.client;
		if (!client || !client.isReady()) {
			return Promise.resolve({kind: 'no_relay'});
		}
		if (signal.aborted) {
			return Promise.resolve({kind: 'cancelled', reason: 'auto_resolved'});
		}
		client.sendFrame({
			kind: 'console.permission.request',
			frameId: makeFrameId(),
			sentAt: Date.now(),
			address: {
				runnerId: this.opts.runnerId,
				...(this.opts.workspaceId !== undefined
					? {workspaceId: this.opts.workspaceId}
					: {}),
			},
			channelRequestId: req.channelRequestId,
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
		});
		return new Promise<PermissionRelayResult>(resolve => {
			const abortListener = (): void => {
				const entry = this.pendingPermissions.get(req.channelRequestId);
				if (!entry) return;
				this.pendingPermissions.delete(req.channelRequestId);
				try {
					this.client?.sendFrame({
						kind: 'console.permission.cancel',
						frameId: makeFrameId(),
						sentAt: Date.now(),
						channelRequestId: req.channelRequestId,
						reason: 'resolved_by_other_channel',
					});
				} catch {
					// best-effort cancel
				}
				resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
			};
			signal.addEventListener('abort', abortListener);
			this.pendingPermissions.set(req.channelRequestId, {
				resolve,
				abortListener,
				signal,
			});
		});
	}

	private settlePermissionResponse(
		channelRequestId: string,
		decision: 'allow' | 'deny',
	): void {
		const entry = this.pendingPermissions.get(channelRequestId);
		if (!entry) return;
		this.pendingPermissions.delete(channelRequestId);
		entry.signal.removeEventListener('abort', entry.abortListener);
		entry.resolve({kind: 'verdict', behavior: decision, channelId: CONSOLE_ID});
	}

	private disposePermissions(
		reason: 'auto_resolved' | 'connection_lost' = 'auto_resolved',
	): void {
		for (const [id, entry] of [...this.pendingPermissions.entries()]) {
			this.pendingPermissions.delete(id);
			entry.signal.removeEventListener('abort', entry.abortListener);
			entry.resolve({kind: 'cancelled', reason});
		}
	}

	requestQuestionAnswer(
		req: QuestionRelayRequest,
		signal: AbortSignal,
	): Promise<QuestionRelayResult> {
		const client = this.client;
		if (!client || !client.isReady()) {
			return Promise.resolve({kind: 'no_relay'});
		}
		if (signal.aborted) {
			return Promise.resolve({kind: 'cancelled', reason: 'auto_resolved'});
		}
		client.sendFrame({
			kind: 'console.question.request',
			frameId: makeFrameId(),
			sentAt: Date.now(),
			address: {
				runnerId: this.opts.runnerId,
				...(this.opts.workspaceId !== undefined
					? {workspaceId: this.opts.workspaceId}
					: {}),
			},
			channelRequestId: req.channelRequestId,
			title: req.title,
			questions: req.questions,
		});
		return new Promise<QuestionRelayResult>(resolve => {
			const abortListener = (): void => {
				const entry = this.pendingQuestions.get(req.channelRequestId);
				if (!entry) return;
				this.pendingQuestions.delete(req.channelRequestId);
				try {
					this.client?.sendFrame({
						kind: 'console.question.cancel',
						frameId: makeFrameId(),
						sentAt: Date.now(),
						channelRequestId: req.channelRequestId,
						reason: 'resolved_by_other_channel',
					});
				} catch {
					// best-effort cancel
				}
				resolve({kind: 'cancelled', reason: 'resolved_by_other_channel'});
			};
			signal.addEventListener('abort', abortListener);
			this.pendingQuestions.set(req.channelRequestId, {
				questionKeys: req.questions.map(q => q.key),
				resolve,
				abortListener,
				signal,
			});
		});
	}

	private settleQuestionResponse(
		channelRequestId: string,
		answers: Record<string, string>,
	): void {
		const entry = this.pendingQuestions.get(channelRequestId);
		if (!entry) return;
		const filtered: Record<string, string> = {};
		for (const key of entry.questionKeys) {
			const value = answers[key];
			if (typeof value === 'string') filtered[key] = value;
		}
		this.pendingQuestions.delete(channelRequestId);
		entry.signal.removeEventListener('abort', entry.abortListener);
		if (Object.keys(filtered).length === 0) {
			entry.resolve({kind: 'cancelled', reason: 'auto_resolved'});
			return;
		}
		entry.resolve({kind: 'answer', answers: filtered, channelId: CONSOLE_ID});
	}

	private disposeQuestions(
		reason: 'auto_resolved' | 'connection_lost' = 'auto_resolved',
	): void {
		for (const [id, entry] of [...this.pendingQuestions.entries()]) {
			this.pendingQuestions.delete(id);
			entry.signal.removeEventListener('abort', entry.abortListener);
			entry.resolve({kind: 'cancelled', reason});
		}
	}

	private handleInboundFrame(frame: AthenaConsoleFrame): void {
		// Most frame kinds (hello/ready/error/ack/cancel/outbound/request) are
		// not produced broker→adapter, or are consumed by the broker client
		// itself before reaching this handler. We intentionally only react to
		// the handful of kinds that drive adapter state.
		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		switch (frame.kind) {
			case 'console.message.in': {
				const inbound = normalizeInbound(frame, this.opts.runnerId);
				if (!inbound || !this.ctx) return;
				try {
					this.ctx.emitInbound(inbound);
				} catch (err) {
					this.ctx.log(
						'warn',
						`console emitInbound threw: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				return;
			}
			case 'console.permission.response':
				this.settlePermissionResponse(frame.channelRequestId, frame.decision);
				return;
			case 'console.question.response':
				this.settleQuestionResponse(frame.channelRequestId, frame.answers);
				return;
			default:
				return;
		}
	}
}

function resolvePairingToken(opts: ConsoleAdapterOptions): string {
	if (opts.pairingToken !== undefined && opts.pairingToken.length > 0) {
		return opts.pairingToken;
	}
	if (opts.tokenPath !== undefined && opts.tokenPath.length > 0) {
		try {
			const value = readFileSync(opts.tokenPath, 'utf-8').trim();
			if (value.length === 0) {
				throw new Error(
					`console adapter: token_path ${opts.tokenPath} is empty`,
				);
			}
			return value;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			throw new Error(
				`console adapter: failed to read token_path ${opts.tokenPath}` +
					(code ? ` (${code})` : '') +
					(err instanceof Error ? `: ${err.message}` : ''),
			);
		}
	}
	throw new Error('console adapter: no pairing_token or token_path configured');
}

let outboundCounter = 0;
function makeOutboundMessageId(): string {
	outboundCounter = (outboundCounter + 1) % 1_000_000;
	return `console-out-${Date.now().toString(36)}-${outboundCounter.toString(36)}`;
}

let frameCounter = 0;
function makeFrameId(): string {
	frameCounter = (frameCounter + 1) % 1_000_000;
	return `f${Date.now().toString(36)}-${frameCounter.toString(36)}`;
}

function normalizeInbound(
	frame: AthenaConsoleInboundMessageFrame,
	runnerId: string,
): NormalizedInbound | null {
	if (typeof frame.text !== 'string' || frame.text.length === 0) return null;
	const userId = frame.address.userId ?? 'console-user';
	const idempotencyKey =
		typeof frame.idempotencyKey === 'string' && frame.idempotencyKey.length > 0
			? frame.idempotencyKey
			: `console:${runnerId}:${frame.messageId}`;
	return {
		location: {
			channelId: CONSOLE_ID,
			accountId: frame.address.workspaceId ?? runnerId,
			peer: {id: userId, kind: 'user'},
			...(frame.address.threadId !== undefined
				? {thread: {id: frame.address.threadId}}
				: frame.address.conversationId !== undefined
					? {thread: {id: frame.address.conversationId}}
					: {}),
		},
		sender: {id: userId},
		text: frame.text,
		receivedAt: frame.sentAt,
		idempotencyKey,
		providerMessageId: frame.messageId,
	};
}
