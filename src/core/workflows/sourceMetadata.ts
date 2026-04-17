import fs from 'node:fs';
import path from 'node:path';
import {
	findMarketplaceRepoDir,
	listMarketplaceWorkflowsFromRepo,
} from '../../infra/plugins/marketplace';
import type {WorkflowSourceMetadata} from './types';

function legacyLocalToNew(
	legacyPath: string,
	legacyRepoDir: string | undefined,
): WorkflowSourceMetadata {
	const repoDir = legacyRepoDir ?? findMarketplaceRepoDir(legacyPath);
	if (!repoDir) {
		return {kind: 'filesystem', path: legacyPath};
	}
	try {
		const canonicalRepoDir = fs.realpathSync(repoDir);
		const listings = listMarketplaceWorkflowsFromRepo(canonicalRepoDir);
		const absolutePath = fs.realpathSync(legacyPath);
		const match = listings.find(
			l => fs.realpathSync(l.workflowPath) === absolutePath,
		);
		if (match) {
			return {
				kind: 'marketplace-local',
				repoDir: canonicalRepoDir,
				workflowName: match.name,
				...(match.version ? {version: match.version} : {}),
			};
		}
	} catch {
		// Fall through to filesystem kind if the marketplace manifest can't be read.
	}
	return {kind: 'filesystem', path: legacyPath};
}

export function readWorkflowSourceMetadata(
	workflowDir: string,
): WorkflowSourceMetadata | undefined {
	const sourceFile = path.join(workflowDir, 'source.json');
	if (!fs.existsSync(sourceFile)) return undefined;

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
	} catch {
		throw new Error(`Invalid source.json: ${sourceFile} is not valid JSON`);
	}
	if (!raw || typeof raw !== 'object') {
		throw new Error(
			`Invalid source.json: ${sourceFile} must contain an object`,
		);
	}

	const r = raw as Record<string, unknown>;

	if (r['v'] === 2) {
		if (r['kind'] === 'marketplace-remote' && typeof r['ref'] === 'string') {
			return {
				kind: 'marketplace-remote',
				ref: r['ref'],
				...(typeof r['version'] === 'string' ? {version: r['version']} : {}),
			};
		}
		if (
			r['kind'] === 'marketplace-local' &&
			typeof r['repoDir'] === 'string' &&
			typeof r['workflowName'] === 'string'
		) {
			return {
				kind: 'marketplace-local',
				repoDir: r['repoDir'],
				workflowName: r['workflowName'],
				...(typeof r['version'] === 'string' ? {version: r['version']} : {}),
			};
		}
		if (r['kind'] === 'filesystem' && typeof r['path'] === 'string') {
			return {kind: 'filesystem', path: r['path']};
		}
	}

	// Legacy v0 shapes.
	if (r['kind'] === 'marketplace' && typeof r['ref'] === 'string') {
		return {kind: 'marketplace-remote', ref: r['ref']};
	}
	if (r['kind'] === 'local' && typeof r['path'] === 'string') {
		return legacyLocalToNew(
			r['path'],
			typeof r['repoDir'] === 'string' ? r['repoDir'] : undefined,
		);
	}

	throw new Error(`Invalid source.json: ${sourceFile} kind is not supported`);
}

export function writeWorkflowSourceMetadata(
	workflowDir: string,
	metadata: WorkflowSourceMetadata,
): void {
	fs.mkdirSync(workflowDir, {recursive: true});
	fs.writeFileSync(
		path.join(workflowDir, 'source.json'),
		JSON.stringify({v: 2, ...metadata}),
		'utf-8',
	);
}
