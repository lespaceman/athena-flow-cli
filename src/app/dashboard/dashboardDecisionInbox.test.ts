import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createDashboardDecisionInbox} from './dashboardDecisionInbox';

const tmpDirs: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-decision-inbox-'));
	tmpDirs.push(dir);
	return path.join(dir, 'inbox.db');
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe('DashboardDecisionInbox', () => {
	it('persists dashboard decisions until a local session consumes them', () => {
		const dbPath = tempDbPath();
		const inbox = createDashboardDecisionInbox({dbPath});

		inbox.enqueue({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 123,
		});
		inbox.close();

		const reopened = createDashboardDecisionInbox({dbPath});
		const pending = reopened.pendingForSession({
			athenaSessionId: 'athena-1',
			limit: 10,
		});
		expect(pending).toEqual([
			expect.objectContaining({
				requestId: 'req-1',
				decision: expect.objectContaining({
					intent: {kind: 'permission_allow'},
				}),
			}),
		]);

		reopened.markConsumed({id: pending[0]!.id});
		expect(
			reopened.pendingForSession({athenaSessionId: 'athena-1', limit: 10}),
		).toEqual([]);
		reopened.close();
	});
});
