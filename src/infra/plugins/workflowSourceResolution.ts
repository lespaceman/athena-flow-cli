import fs from 'node:fs';
import path from 'node:path';
import {
	ensureRepo,
	isMarketplaceRef,
	isMarketplaceSlug,
	listWorkflowEntriesFromManifest,
	parseRef,
	requireGitForMarketplace,
	resolvePluginManifestPath,
	resolveWorkflowManifestPath,
	resolveWorkflowPathFromManifest,
	type MarketplaceWorkflowListing,
	type WorkflowMarketplaceSource,
} from './marketplaceShared';

export function findMarketplaceRepoDir(startPath: string): string | undefined {
	let currentDir = path.resolve(startPath);

	for (;;) {
		if (
			fs.existsSync(resolveWorkflowManifestPath(currentDir)) ||
			fs.existsSync(resolvePluginManifestPath(currentDir))
		) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

export function resolveWorkflowMarketplaceSource(
	source: string,
): WorkflowMarketplaceSource {
	const trimmed = source.trim();
	const resolvedPath = path.resolve(trimmed);

	if (!fs.existsSync(resolvedPath) && isMarketplaceSlug(trimmed)) {
		const slashIdx = trimmed.indexOf('/');
		return {
			kind: 'remote',
			slug: trimmed,
			owner: trimmed.slice(0, slashIdx),
			repo: trimmed.slice(slashIdx + 1),
		};
	}

	const repoDir = findMarketplaceRepoDir(trimmed);
	if (!repoDir) {
		throw new Error(
			`Local marketplace not found from source: ${trimmed}. Expected a marketplace repo root or a path inside one.`,
		);
	}

	return {
		kind: 'local',
		path: resolvedPath,
		repoDir,
	};
}

export function listMarketplaceWorkflows(
	owner: string,
	repo: string,
): MarketplaceWorkflowListing[] {
	requireGitForMarketplace('workflows');
	const repoDir = ensureRepo(owner, repo);
	return listWorkflowEntriesFromManifest(
		repoDir,
		resolveWorkflowManifestPath(repoDir),
		owner,
		repo,
	);
}

export function listMarketplaceWorkflowsFromRepo(
	repoDir: string,
	owner = 'local',
	repo = path.basename(repoDir),
): MarketplaceWorkflowListing[] {
	return listWorkflowEntriesFromManifest(
		repoDir,
		resolveWorkflowManifestPath(repoDir),
		owner,
		repo,
	);
}

export function resolveMarketplaceWorkflow(ref: string): string {
	requireGitForMarketplace('workflows');
	const {pluginName: workflowName, owner, repo} = parseRef(ref);
	const repoDir = ensureRepo(owner, repo);
	return resolveWorkflowPathFromManifest(
		workflowName,
		repoDir,
		resolveWorkflowManifestPath(repoDir),
	);
}

export function resolveWorkflowInstallSource(
	source: string,
	configuredMarketplaceSource: string,
): string {
	if (isMarketplaceRef(source)) {
		return source;
	}

	const resolvedPath = path.resolve(source);
	if (fs.existsSync(resolvedPath)) {
		return source;
	}

	if (source.includes('/') || source.includes('\\')) {
		throw new Error(`Workflow source not found: ${source}`);
	}

	const marketplaceSource = resolveWorkflowMarketplaceSource(
		configuredMarketplaceSource,
	);

	if (marketplaceSource.kind === 'remote') {
		const workflow = listMarketplaceWorkflows(
			marketplaceSource.owner,
			marketplaceSource.repo,
		).find(entry => entry.name === source);
		if (!workflow) {
			throw new Error(
				`Workflow "${source}" not found in marketplace ${marketplaceSource.slug}`,
			);
		}
		return workflow.ref;
	}

	const workflow = listMarketplaceWorkflowsFromRepo(
		marketplaceSource.repoDir,
	).find(entry => entry.name === source);
	if (!workflow) {
		throw new Error(
			`Workflow "${source}" not found in local marketplace ${marketplaceSource.repoDir}`,
		);
	}
	return workflow.workflowPath;
}

export function resolveWorkflowInstallSourceFromSources(
	name: string,
	sources: string[],
): string {
	for (const source of sources) {
		try {
			return resolveWorkflowInstallSource(name, source);
		} catch {
			// try next configured source
		}
	}
	throw new Error(`Workflow "${name}" not found in any configured marketplace`);
}
