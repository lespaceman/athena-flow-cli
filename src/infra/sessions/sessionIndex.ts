import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import type {SessionEntry} from '../../shared/types/session';

type RawSessionEntry = SessionEntry & {
	fullPath: string;
	fileMtime: number;
	projectPath: string;
	isSidechain: boolean;
};

type SessionIndex = {
	version: number;
	entries: RawSessionEntry[];
};

export function encodeProjectPath(projectDir: string): string {
	return projectDir.replaceAll('/', '-').replace(/^-/, '');
}

export function readSessionIndex(projectDir: string): SessionEntry[] {
	const encoded = encodeProjectPath(projectDir);
	const indexPath = join(
		homedir(),
		'.claude',
		'projects',
		encoded,
		'sessions-index.json',
	);

	try {
		const raw = readFileSync(indexPath, 'utf-8');
		const index = JSON.parse(raw) as SessionIndex;

		return index.entries
			.filter(e => !e.isSidechain)
			.map(
				({
					sessionId,
					summary,
					firstPrompt,
					modified,
					created,
					gitBranch,
					messageCount,
				}) => ({
					sessionId,
					summary,
					firstPrompt,
					modified,
					created,
					gitBranch,
					messageCount,
				}),
			)
			.sort(
				(a, b) =>
					new Date(b.modified).getTime() - new Date(a.modified).getTime(),
			);
	} catch {
		return [];
	}
}

export function getMostRecentSession(projectDir: string): SessionEntry | null {
	const entries = readSessionIndex(projectDir);
	return entries[0] ?? null;
}
