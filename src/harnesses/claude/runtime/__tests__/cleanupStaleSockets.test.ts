import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {cleanupStaleSockets} from '../cleanupStaleSockets';

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'athena-sock-cleanup-'));
}

describe('cleanupStaleSockets', () => {
	let sockDir: string;

	beforeEach(() => {
		sockDir = makeTmpDir();
	});

	afterEach(() => {
		fs.rmSync(sockDir, {recursive: true, force: true});
	});

	it('removes socket files whose PID does not exist', () => {
		const stalePath = path.join(sockDir, 'ink-999999999.sock');
		fs.writeFileSync(stalePath, '');

		const removed = cleanupStaleSockets(sockDir);

		expect(removed).toEqual(['ink-999999999.sock']);
		expect(fs.existsSync(stalePath)).toBe(false);
	});

	it('preserves socket files whose PID is alive', () => {
		const livePath = path.join(sockDir, `ink-${process.pid}.sock`);
		fs.writeFileSync(livePath, '');

		const removed = cleanupStaleSockets(sockDir);

		expect(removed).toEqual([]);
		expect(fs.existsSync(livePath)).toBe(true);
	});

	it('ignores non-socket files in the directory', () => {
		const otherFile = path.join(sockDir, 'something-else.txt');
		fs.writeFileSync(otherFile, '');

		const removed = cleanupStaleSockets(sockDir);

		expect(removed).toEqual([]);
		expect(fs.existsSync(otherFile)).toBe(true);
	});

	it('handles missing directory gracefully', () => {
		const removed = cleanupStaleSockets('/tmp/nonexistent-dir-athena-test');
		expect(removed).toEqual([]);
	});

	it('removes multiple stale sockets in one sweep', () => {
		fs.writeFileSync(path.join(sockDir, 'ink-999999991.sock'), '');
		fs.writeFileSync(path.join(sockDir, 'ink-999999992.sock'), '');
		fs.writeFileSync(path.join(sockDir, 'ink-999999993.sock'), '');

		const removed = cleanupStaleSockets(sockDir);

		expect(removed.sort()).toEqual([
			'ink-999999991.sock',
			'ink-999999992.sock',
			'ink-999999993.sock',
		]);
		expect(fs.readdirSync(sockDir)).toEqual([]);
	});

	it('skips files that do not match ink-{PID}.sock pattern', () => {
		fs.writeFileSync(path.join(sockDir, 'ink-.sock'), '');
		fs.writeFileSync(path.join(sockDir, 'ink-abc.sock'), '');
		fs.writeFileSync(path.join(sockDir, 'other-123.sock'), '');

		const removed = cleanupStaleSockets(sockDir);

		expect(removed).toEqual([]);
		expect(fs.readdirSync(sockDir).length).toBe(3);
	});
});
