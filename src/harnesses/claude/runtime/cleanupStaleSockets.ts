/**
 * Sweeps .claude/run/ for stale ink-{PID}.sock files left by crashed processes.
 * Returns the list of filenames that were removed (for logging/testing).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOCK_PATTERN = /^ink-(\d+)\.sock$/;

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// EPERM means the process exists but we lack permission to signal it
		const code = (err as NodeJS.ErrnoException).code;
		return code === 'EPERM';
	}
}

export function cleanupStaleSockets(sockDir: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(sockDir);
	} catch {
		return [];
	}

	const removed: string[] = [];
	for (const entry of entries) {
		const match = SOCK_PATTERN.exec(entry);
		if (!match) continue;

		const pid = parseInt(match[1]!, 10);
		if (isPidAlive(pid)) continue;

		try {
			fs.unlinkSync(path.join(sockDir, entry));
			removed.push(entry);
		} catch {
			// Best effort — file may have been removed concurrently
		}
	}

	return removed;
}
