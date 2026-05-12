import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {FeedEvent} from '../../core/feed/types';
import {
	createDashboardFeedOutbox,
	createDashboardFeedPublisher,
} from './dashboardFeedPublisher';

const tmpDirs: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-feed-outbox-'));
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
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('DashboardFeedPublisher', () => {
	it('does not enqueue feed events when the instance is unpaired', () => {
		const dbPath = tempDbPath();
		const outbox = createDashboardFeedOutbox({dbPath});
		const publisher = createDashboardFeedPublisher({
			readConfig: () => null,
			outbox,
		});

		publisher.publish({
			origin: 'local',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent()],
		});

		expect(outbox.pendingBatch({limit: 10, now: 1})).toEqual([]);
		outbox.close();
	});

	it('enqueues canonical feed envelopes with stable event ids and delivery sequence numbers', () => {
		const dbPath = tempDbPath();
		const outbox = createDashboardFeedOutbox({dbPath});
		const publisher = createDashboardFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 2222,
		});

		publisher.publish({
			origin: 'dashboard',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent()],
		});
		publisher.publish({
			origin: 'dashboard',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent()],
		});

		const pending = outbox.pendingBatch({limit: 10, now: 2222});
		expect(pending).toHaveLength(1);
		expect(pending[0]!.deliverySeq).toBe(1);
		expect(pending[0]!.envelope).toMatchObject({
			instanceId: 'inst-1',
			athenaSessionId: 'athena-1',
			runId: 'run-1',
			origin: 'dashboard',
			eventId: 'athena-1:feed-1',
			feedSeq: 1,
			emittedAt: 2222,
			feedEvent: expect.objectContaining({
				event_id: 'feed-1',
				seq: 7,
			}),
		});
		outbox.close();
	});

	it('replays unacked feed events after the outbox is reopened', () => {
		const dbPath = tempDbPath();
		const outbox = createDashboardFeedOutbox({dbPath});
		const publisher = createDashboardFeedPublisher({
			readConfig: () => ({
				dashboardUrl: 'https://dashboard.test',
				instanceId: 'inst-1',
				refreshToken: 'refresh',
				fingerprint: 'fp',
				pairedAt: 1,
			}),
			outbox,
			now: () => 3333,
		});

		publisher.publish({
			origin: 'local',
			athenaSessionId: 'athena-1',
			feedEvents: [notificationEvent()],
		});
		outbox.close();

		const reopened = createDashboardFeedOutbox({dbPath});
		const pending = reopened.pendingBatch({limit: 10, now: 3333});
		expect(pending.map(row => row.envelope.eventId)).toEqual([
			'athena-1:feed-1',
		]);

		reopened.markAcked({deliverySeq: pending[0]!.deliverySeq});
		expect(reopened.pendingBatch({limit: 10, now: 3333})).toEqual([]);
		reopened.close();
	});
});
