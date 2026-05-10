import {describe, expect, it, vi} from 'vitest';
import type {
	AdapterContext,
	ChannelAdapter,
	NormalizedInbound,
	OutboundMessage,
	StopReason,
} from '../shared/gateway-protocol';
import {
	ChannelManager,
	DuplicateChannelError,
	UnknownChannelError,
} from './channelManager';

class FakeAdapter implements ChannelAdapter {
	readonly id: string;
	readonly capabilities = {
		chat: true,
		threads: false,
		relayPermission: false,
		relayQuestion: false,
	} as const;
	private ctx: AdapterContext | null = null;
	startCalls = 0;
	stopCalls: StopReason[] = [];
	sentMessages: OutboundMessage[] = [];
	startError?: Error;

	constructor(id = 'fake') {
		this.id = id;
	}

	async start(ctx: AdapterContext): Promise<void> {
		this.startCalls++;
		this.ctx = ctx;
		if (this.startError) throw this.startError;
	}

	async stop(reason: StopReason): Promise<void> {
		this.stopCalls.push(reason);
		this.ctx = null;
	}

	async send(msg: OutboundMessage) {
		this.sentMessages.push(msg);
		return {providerMessageId: `m${this.sentMessages.length}`, deliveredAt: 1};
	}

	async probe() {
		return {ok: true, checkedAt: 1};
	}

	emitInbound(msg: NormalizedInbound): void {
		this.ctx?.emitInbound(msg);
	}

	emitHealth(at: number, ok: boolean): void {
		this.ctx?.emitHealth({at, transportOk: ok});
	}
}

function inbound(idemKey: string, text = 'hi'): NormalizedInbound {
	return {
		location: {
			channelId: 'fake',
			accountId: 'a',
			peer: {id: '1', kind: 'user'},
		},
		sender: {id: '1'},
		text,
		receivedAt: 100,
		idempotencyKey: idemKey,
		providerMessageId: 'pm',
	};
}

describe('ChannelManager', () => {
	it('starts and stops adapters; routes inbound to the registered sink', async () => {
		const mgr = new ChannelManager();
		const adapter = new FakeAdapter();
		const sink = vi.fn();
		mgr.setInboundSink(sink);

		await mgr.register(adapter);
		expect(adapter.startCalls).toBe(1);

		adapter.emitInbound(inbound('k1'));
		expect(sink).toHaveBeenCalledTimes(1);
		expect(sink.mock.calls[0]?.[0].text).toBe('hi');

		await mgr.stop();
		expect(adapter.stopCalls).toEqual(['shutdown']);
	});

	it('drops duplicate inbound messages by idempotencyKey', async () => {
		const mgr = new ChannelManager();
		const adapter = new FakeAdapter();
		const sink = vi.fn();
		mgr.setInboundSink(sink);
		await mgr.register(adapter);

		adapter.emitInbound(inbound('dup'));
		adapter.emitInbound(inbound('dup'));
		adapter.emitInbound(inbound('other'));
		expect(sink).toHaveBeenCalledTimes(2);
		await mgr.stop();
	});

	it('rejects duplicate registrations and unknown sends', async () => {
		const mgr = new ChannelManager();
		const adapter = new FakeAdapter();
		await mgr.register(adapter);
		await expect(mgr.register(new FakeAdapter('fake'))).rejects.toBeInstanceOf(
			DuplicateChannelError,
		);
		await expect(
			mgr.send('missing', {
				location: {channelId: 'fake', accountId: 'a'},
				text: 't',
				idempotencyKey: 'i',
			}),
		).rejects.toBeInstanceOf(UnknownChannelError);
		await mgr.stop();
	});

	it('forwards outbound sends to the matching adapter', async () => {
		const mgr = new ChannelManager();
		const adapter = new FakeAdapter('fake');
		await mgr.register(adapter);
		const out: OutboundMessage = {
			location: {
				channelId: 'fake',
				accountId: 'a',
				peer: {id: '7', kind: 'user'},
			},
			text: 'hello',
			idempotencyKey: 'k',
		};
		const result = await mgr.send('fake', out);
		expect(result.providerMessageId).toBe('m1');
		expect(adapter.sentMessages).toEqual([out]);
		await mgr.stop();
	});

	it('records last health sample and forwards to health sink', async () => {
		const mgr = new ChannelManager();
		const adapter = new FakeAdapter();
		const healthSink = vi.fn();
		mgr.setHealthSink(healthSink);
		await mgr.register(adapter);
		adapter.emitHealth(123, true);
		expect(healthSink).toHaveBeenCalledTimes(1);
		expect(mgr.listChannels()[0]?.health?.transportOk).toBe(true);
		await mgr.stop();
	});

	it('cleans up listeners when start throws', async () => {
		const mgr = new ChannelManager();
		const adapter = new FakeAdapter();
		adapter.startError = new Error('boom');
		await expect(mgr.register(adapter)).rejects.toThrow('boom');
		expect(mgr.listChannels()).toEqual([]);
	});

	describe('attachment-keyed registration', () => {
		it('records attachmentId on register and exposes it via getAttachmentId', async () => {
			const mgr = new ChannelManager();
			const adapter = new FakeAdapter('console:r1');
			await mgr.register(adapter, {attachmentId: 'r1'});
			expect(mgr.getAttachmentId('console:r1')).toBe('r1');
			await mgr.stop();
		});

		it('returns undefined for adapters registered without an attachmentId', async () => {
			const mgr = new ChannelManager();
			const adapter = new FakeAdapter('legacy');
			await mgr.register(adapter);
			expect(mgr.getAttachmentId('legacy')).toBeUndefined();
			await mgr.stop();
		});

		it('returns undefined for unknown channel ids', () => {
			const mgr = new ChannelManager();
			expect(mgr.getAttachmentId('nope')).toBeUndefined();
		});

		it('forwards attachmentId to the inbound sink alongside the message', async () => {
			const mgr = new ChannelManager();
			const a1 = new FakeAdapter('console:r1');
			const a2 = new FakeAdapter('legacy');
			const sink = vi.fn();
			mgr.setInboundSink(sink);
			await mgr.register(a1, {attachmentId: 'r1'});
			await mgr.register(a2);

			a1.emitInbound(inbound('k1'));
			a2.emitInbound(inbound('k2'));

			expect(sink).toHaveBeenCalledTimes(2);
			expect(sink.mock.calls[0]?.[1]).toEqual({attachmentId: 'r1'});
			expect(sink.mock.calls[1]?.[1]).toEqual({attachmentId: undefined});
			await mgr.stop();
		});

		it('clears the attachmentId mapping when the channel is unregistered', async () => {
			const mgr = new ChannelManager();
			const adapter = new FakeAdapter('console:r1');
			await mgr.register(adapter, {attachmentId: 'r1'});
			await mgr.unregister('console:r1', 'shutdown');
			expect(mgr.getAttachmentId('console:r1')).toBeUndefined();
		});
	});
});
