import {describe, expect, it, vi} from 'vitest';
import type {AttachmentRunner} from './attachmentRunner';
import {createAttachmentSet} from './attachmentSet';

function fakeRunner(attachmentId: string, runnerId: string): AttachmentRunner {
	return {
		attachmentId,
		runnerId,
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		onChildExit: vi.fn(),
	};
}

describe('AttachmentSet', () => {
	it('reconcile starts a runner for each desired attachment', async () => {
		const created: AttachmentRunner[] = [];
		const set = createAttachmentSet({
			createRunner: input => {
				const r = fakeRunner(input.attachmentId, input.runnerId);
				created.push(r);
				return r;
			},
		});
		await set.reconcile([{attachmentId: 'a1', runnerId: 'r1'}]);
		expect(created).toHaveLength(1);
		expect(created[0]?.attachmentId).toBe('a1');
		expect(created[0]?.start).toHaveBeenCalledTimes(1);
	});

	it('reconcile is idempotent — re-passing the same desired set creates no new runners', async () => {
		const created: AttachmentRunner[] = [];
		const set = createAttachmentSet({
			createRunner: input => {
				const r = fakeRunner(input.attachmentId, input.runnerId);
				created.push(r);
				return r;
			},
		});
		const desired = [
			{attachmentId: 'a1', runnerId: 'r1'},
			{attachmentId: 'a2', runnerId: 'r2'},
		];
		await set.reconcile(desired);
		await set.reconcile(desired);
		expect(created).toHaveLength(2);
		expect(created[0]?.start).toHaveBeenCalledTimes(1);
		expect(created[1]?.start).toHaveBeenCalledTimes(1);
	});

	it('reconcile stops runners no longer present in the desired set', async () => {
		const created: AttachmentRunner[] = [];
		const set = createAttachmentSet({
			createRunner: input => {
				const r = fakeRunner(input.attachmentId, input.runnerId);
				created.push(r);
				return r;
			},
		});
		await set.reconcile([
			{attachmentId: 'a1', runnerId: 'r1'},
			{attachmentId: 'a2', runnerId: 'r2'},
		]);
		await set.reconcile([{attachmentId: 'a2', runnerId: 'r2'}]);
		expect(created[0]?.stop).toHaveBeenCalledWith('detach');
		expect(created[1]?.stop).not.toHaveBeenCalled();
	});

	it('reconcile replaces a runner whose runnerId changed under the same attachmentId', async () => {
		const created: AttachmentRunner[] = [];
		const set = createAttachmentSet({
			createRunner: input => {
				const r = fakeRunner(input.attachmentId, input.runnerId);
				created.push(r);
				return r;
			},
		});
		await set.reconcile([{attachmentId: 'a1', runnerId: 'r1'}]);
		await set.reconcile([{attachmentId: 'a1', runnerId: 'r2'}]);
		expect(created).toHaveLength(2);
		expect(created[0]?.runnerId).toBe('r1');
		expect(created[0]?.stop).toHaveBeenCalledWith('detach');
		expect(created[1]?.runnerId).toBe('r2');
		expect(created[1]?.start).toHaveBeenCalledTimes(1);
	});

	it('shutdown stops every running runner', async () => {
		const created: AttachmentRunner[] = [];
		const set = createAttachmentSet({
			createRunner: input => {
				const r = fakeRunner(input.attachmentId, input.runnerId);
				created.push(r);
				return r;
			},
		});
		await set.reconcile([
			{attachmentId: 'a1', runnerId: 'r1'},
			{attachmentId: 'a2', runnerId: 'r2'},
		]);
		await set.shutdown();
		expect(created[0]?.stop).toHaveBeenCalledWith('shutdown');
		expect(created[1]?.stop).toHaveBeenCalledWith('shutdown');
	});

	it('list() exposes the current set of attachment/runner pairs', async () => {
		const set = createAttachmentSet({
			createRunner: input => fakeRunner(input.attachmentId, input.runnerId),
		});
		await set.reconcile([
			{attachmentId: 'a1', runnerId: 'r1'},
			{attachmentId: 'a2', runnerId: 'r2'},
		]);
		expect(set.list()).toEqual([
			{attachmentId: 'a1', runnerId: 'r1'},
			{attachmentId: 'a2', runnerId: 'r2'},
		]);
	});
});
