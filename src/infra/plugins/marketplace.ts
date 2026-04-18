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
	formatWorkflowListingSource,
	isMarketplaceRef,
	isMarketplaceSlug,
	marketplaceRepoCacheDir,
	parseRef,
	requireGitForMarketplace,
	resolvePluginDirFromManifest,
	resolvePluginManifestPath,
	resolvePluginVersionFromDir,
	resolveWorkflowManifestPath,
	type MarketplaceEntry,
	type MarketplaceManifest,
	type MarketplacePluginTarget,
	type MarketplaceWorkflowListing,
	type WorkflowListingSource,
	type WorkflowMarketplaceSource,
} from './marketplaceShared';
import {
	pluginNpmPackageName,
	refreshVersionedMarketplacePluginTarget,
	resolveVersionedMarketplacePluginTarget,
	resolveVersionedPluginDir,
} from './versionedPluginResolution';
import {
	findMarketplaceRepoDir,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveMarketplaceWorkflow,
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
	const directTarget = buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
	const pluginVersion = resolvePluginVersionFromDir(directTarget.pluginDir);
	if (!pluginVersion) {
		return directTarget;
	}

	return resolveVersionedMarketplacePluginTarget(ref, pluginVersion, repoDir);
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
	formatWorkflowListingSource,
	isMarketplaceRef,
	isMarketplaceSlug,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	pluginNpmPackageName,
	refreshVersionedMarketplacePluginTarget,
	resolveMarketplaceWorkflow,
	resolveVersionedMarketplacePluginTarget,
	resolveVersionedPluginDir,
	resolveWorkflowManifestPath,
	resolveWorkflowMarketplaceSource,
};

export {
	resolveWorkflowInstall,
	gatherMarketplaceWorkflowSources,
	type ResolvedWorkflowSource,
} from './workflowSourceResolution';
export {
	WorkflowAmbiguityError,
	WorkflowNotFoundError,
	WorkflowVersionNotFoundError,
	type WorkflowAmbiguityCandidate,
} from './workflowSourceErrors';

export type {
	MarketplaceEntry,
	MarketplaceManifest,
	MarketplacePluginTarget,
	MarketplaceWorkflowListing,
	WorkflowListingSource,
	WorkflowMarketplaceSource,
};
