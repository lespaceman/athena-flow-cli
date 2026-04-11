/**
 * Marketplace plugin resolver — public entry points for workflow plugin and
 * workflow source resolution. Implementation primitives live in
 * `marketplaceShared.ts`, `versionedPluginResolution.ts`, and
 * `workflowSourceResolution.ts`; this module re-exports the public surface.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {
	buildMarketplacePluginResolution,
	ensureRepo,
	isMarketplaceRef,
	isMarketplaceSlug,
	marketplaceRepoCacheDir,
	parseRef,
	requireGitForMarketplace,
	resolvePluginDirFromManifest,
	resolvePluginManifestPath,
	type MarketplaceEntry,
	type MarketplaceManifest,
	type MarketplacePluginTarget,
	type MarketplaceWorkflowListing,
	type WorkflowMarketplaceSource,
} from './marketplaceShared';
import {
	pluginNpmPackageName,
	resolveVersionedMarketplacePluginTarget,
	resolveVersionedPluginDir,
} from './versionedPluginResolution';
import {
	findMarketplaceRepoDir,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveMarketplaceWorkflow,
	resolveWorkflowInstallSource,
	resolveWorkflowInstallSourceFromSources,
	resolveWorkflowMarketplaceSource,
} from './workflowSourceResolution';

/**
 * Pull latest changes for a cached marketplace repo.
 * Call this explicitly when user requests an update.
 */
export function pullMarketplaceRepo(owner: string, repo: string): void {
	const repoDir = marketplaceRepoCacheDir(owner, repo);

	if (!fs.existsSync(repoDir)) {
		throw new Error(
			`Marketplace repo ${owner}/${repo} is not cached. It will be cloned on first use.`,
		);
	}

	execFileSync('git', ['pull', '--ff-only'], {
		cwd: repoDir,
		stdio: 'ignore',
	});
}

export function resolveMarketplacePlugin(ref: string): string {
	requireGitForMarketplace('plugins');

	const {pluginName, owner, repo} = parseRef(ref);
	const repoDir = ensureRepo(owner, repo);
	return resolvePluginDirFromManifest(
		pluginName,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export function resolveMarketplacePluginTarget(
	ref: string,
): MarketplacePluginTarget {
	requireGitForMarketplace('plugins');

	const {owner, repo} = parseRef(ref);
	const repoDir = ensureRepo(owner, repo);
	return buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export function resolveMarketplacePluginFromRepo(
	ref: string,
	repoDir: string,
): string {
	return resolveMarketplacePluginTargetFromRepo(ref, repoDir).pluginDir;
}

export function resolveMarketplacePluginTargetFromRepo(
	ref: string,
	repoDir: string,
): MarketplacePluginTarget {
	return buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export {
	findMarketplaceRepoDir,
	isMarketplaceRef,
	isMarketplaceSlug,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	pluginNpmPackageName,
	resolveMarketplaceWorkflow,
	resolveVersionedMarketplacePluginTarget,
	resolveVersionedPluginDir,
	resolveWorkflowInstallSource,
	resolveWorkflowInstallSourceFromSources,
	resolveWorkflowMarketplaceSource,
};

export type {
	MarketplaceEntry,
	MarketplaceManifest,
	MarketplacePluginTarget,
	MarketplaceWorkflowListing,
	WorkflowMarketplaceSource,
};
