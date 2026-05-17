import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {FeedEvent} from '../../core/feed/types';
import {createDashboardFeedOutbox} from './dashboardFeedPublisher';
import {createPairedFeedPublisher} from './pairedFeedPublisher';

const tmpDirs: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-paired-feed-'));
	tmpDirs.push(dir);
	return path.join(dir, 'outbox.db');
}

function notificationEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'feed-1',
		seq: 7,
		ts: 1234,
		session_id: 'adapter-1',
		run_id: 'run-1',
		kind: 'notification',
		level: 'info',
		actor_id: 'agent:root',
		title: 'Notice',
		data: {message: 'hello'},
		...overrides,
	} as FeedEvent;
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('PairedFeedPublisher', () => {
	it('publishes canonical feed events durably and retries them until ACKed', async () => {
		vi.useFakeTimers();
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		const sent: unknown[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => Date.now(),
			drainIntervalMs: 100,
		});

		publisher.publish({
			origin: 'local',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent()],
		});
		publisher.attachTransport({
			sendFeedEvent: frame => sent.push(frame),
		});

		expect(sent).toEqual([
			expect.objectContaining({
				deliverySeq: 1,
				envelope: expect.objectContaining({
					eventId: 'athena-1:feed-1',
					feedSeq: 1,
				}),
			}),
		]);

		await vi.advanceTimersByTimeAsync(999);
		expect(sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent).toHaveLength(2);

		publisher.handleAck({type: 'feed_ack', deliverySeq: 1});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sent).toHaveLength(2);
		expect(outbox.pendingBatch({limit: 10, now: Date.now()})).toEqual([]);

		publisher.close();
		outbox.close();
	});

	it('deduplicates repeated canonical feed events and drains them after reconnect', () => {
		const outbox = createDashboardFeedOutbox({dbPath: tempDbPath()});
		const sent: unknown[] = [];
		const publisher = createPairedFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 1234,
		});

		publisher.publish({
			origin: 'dashboard',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent(), notificationEvent()],
		});

		publisher.attachTransport({
			sendFeedEvent: frame => sent.push(frame),
		});
		expect(sent).toHaveLength(1);

		publisher.detachTransport();
		publisher.attachTransport({
			sendFeedEvent: frame => sent.push(frame),
		});
		expect(sent).toHaveLength(2);

		publisher.handleAck({type: 'feed_ack', deliverySeq: 1});
		expect(outbox.pendingBatch({limit: 10, now: 1234})).toEqual([]);

		publisher.close();
		outbox.close();
	});
});
