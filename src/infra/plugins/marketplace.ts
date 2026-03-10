/**
 * Marketplace plugin resolver.
 *
 * Handles config entries like `"web-testing-toolkit@lespaceman/athena-workflow-marketplace"`
 * by cloning the marketplace repo, reading its manifest, and returning the
 * absolute path to the requested plugin directory.
 *
 * Clone/pull behavior:
 * - Clone: only when plugin is in config but repo not found locally
 * - Pull: every startup (gracefully degrades if offline)
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A single plugin entry inside a marketplace manifest. */
export type MarketplaceEntry = {
	name: string;
	source: string | {source: string; [key: string]: unknown};
	description?: string;
	version?: string;
};

/** Shape of marketplace manifests used by athena-cli resolvers. */
export type MarketplaceManifest = {
	name: string;
	owner: {name: string; email?: string};
	metadata?: {
		description?: string;
		version?: string;
		pluginRoot?: string;
		workflowRoot?: string;
	};
	plugins: MarketplaceEntry[];
	workflows?: MarketplaceEntry[];
};

export type MarketplaceWorkflowListing = {
	name: string;
	description?: string;
	version?: string;
	ref: string;
	workflowPath: string;
};

export type WorkflowMarketplaceSource =
	| {
			kind: 'remote';
			slug: string;
			owner: string;
			repo: string;
	  }
	| {
			kind: 'local';
			path: string;
			repoDir: string;
	  };

const MARKETPLACE_REF_RE = /^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const MARKETPLACE_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function resolvePluginManifestPath(repoDir: string): string {
	return path.join(repoDir, '.claude-plugin', 'marketplace.json');
}

function resolveWorkflowManifestPath(repoDir: string): string {
	const preferredManifestPath = path.join(
		repoDir,
		'.athena-workflow',
		'marketplace.json',
	);
	const legacyManifestPath = resolvePluginManifestPath(repoDir);
	return fs.existsSync(preferredManifestPath)
		? preferredManifestPath
		: legacyManifestPath;
}

function readManifest(manifestPath: string): MarketplaceManifest {
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Marketplace manifest not found: ${manifestPath}`);
	}

	return JSON.parse(
		fs.readFileSync(manifestPath, 'utf-8'),
	) as MarketplaceManifest;
}

function resolvePluginDirFromManifest(
	pluginName: string,
	repoDir: string,
	manifestPath: string,
): string {
	const manifest = readManifest(manifestPath);

	if (!Array.isArray(manifest.plugins)) {
		throw new Error(
			`Invalid marketplace manifest at ${manifestPath}: "plugins" must be an array`,
		);
	}

	const entry = manifest.plugins.find(p => p.name === pluginName);
	if (!entry) {
		const available = manifest.plugins.map(p => p.name).join(', ');
		throw new Error(
			`Plugin "${pluginName}" not found in marketplace manifest ${manifestPath}. Available plugins: ${available}`,
		);
	}

	if (typeof entry.source !== 'string') {
		throw new Error(
			`Plugin "${pluginName}" uses a remote source type which is not supported by athena-cli. Only relative path sources are supported.`,
		);
	}

	const {pluginRoot} = manifest.metadata ?? {};
	let sourcePath = entry.source;
	if (
		pluginRoot &&
		!sourcePath.startsWith('./') &&
		!sourcePath.startsWith('../')
	) {
		sourcePath = path.join(pluginRoot, sourcePath);
	}

	const pluginDir = path.resolve(repoDir, sourcePath);

	if (!pluginDir.startsWith(repoDir + path.sep) && pluginDir !== repoDir) {
		throw new Error(
			`Plugin "${pluginName}" source resolves outside the marketplace repo: ${pluginDir}`,
		);
	}

	if (!fs.existsSync(pluginDir)) {
		throw new Error(`Plugin source directory not found: ${pluginDir}`);
	}

	return pluginDir;
}

function resolveWorkflowPathFromManifest(
	workflowName: string,
	repoDir: string,
	manifestPath: string,
): string {
	const manifest = readManifest(manifestPath);
	const workflows = manifest.workflows ?? [];
	const entry = workflows.find(w => w.name === workflowName);
	if (!entry) {
		const available = workflows.map(w => w.name).join(', ') || '(none)';
		throw new Error(
			`Workflow "${workflowName}" not found in marketplace manifest ${manifestPath}. Available workflows: ${available}`,
		);
	}

	if (typeof entry.source !== 'string') {
		throw new Error(
			`Workflow "${workflowName}" uses a remote source type which is not supported.`,
		);
	}

	let sourcePath = entry.source;
	const {workflowRoot} = manifest.metadata ?? {};
	if (
		workflowRoot &&
		!path.isAbsolute(sourcePath) &&
		!sourcePath.startsWith('./') &&
		!sourcePath.startsWith('../')
	) {
		sourcePath = path.join(workflowRoot, sourcePath);
	}

	const workflowPath = path.resolve(repoDir, sourcePath);

	if (
		!workflowPath.startsWith(repoDir + path.sep) &&
		workflowPath !== repoDir
	) {
		throw new Error(
			`Workflow "${workflowName}" source resolves outside the marketplace repo: ${workflowPath}`,
		);
	}

	const resolvedWorkflowPath = preferCanonicalWorkflowPath(
		repoDir,
		workflowPath,
	);

	if (!fs.existsSync(resolvedWorkflowPath)) {
		throw new Error(`Workflow source not found: ${resolvedWorkflowPath}`);
	}

	return resolvedWorkflowPath;
}

function listWorkflowEntriesFromManifest(
	repoDir: string,
	manifestPath: string,
	owner: string,
	repo: string,
): MarketplaceWorkflowListing[] {
	const manifest = readManifest(manifestPath);
	const workflows = manifest.workflows ?? [];

	return workflows
		.filter(
			(entry): entry is MarketplaceEntry & {source: string} =>
				typeof entry.source === 'string',
		)
		.map(entry => ({
			name: entry.name,
			description: entry.description,
			version: entry.version,
			ref: `${entry.name}@${owner}/${repo}`,
			workflowPath: resolveWorkflowPathFromManifest(
				entry.name,
				repoDir,
				manifestPath,
			),
		}));
}

function preferCanonicalWorkflowPath(
	repoDir: string,
	workflowPath: string,
): string {
	const relativePath = path.relative(repoDir, workflowPath);
	const segments = relativePath.split(path.sep);
	if (segments[0] !== '.workflows') {
		return workflowPath;
	}

	const canonicalPath = path.join(repoDir, 'workflows', ...segments.slice(1));
	return fs.existsSync(canonicalPath) ? canonicalPath : workflowPath;
}

/**
 * Test whether a config entry is a marketplace reference
 * (e.g. `"web-testing-toolkit@lespaceman/athena-workflow-marketplace"`).
 */
export function isMarketplaceRef(entry: string): boolean {
	return MARKETPLACE_REF_RE.test(entry);
}

export function isMarketplaceSlug(entry: string): boolean {
	return MARKETPLACE_SLUG_RE.test(entry);
}

/**
 * Parse a marketplace reference into its components.
 * Assumes the ref has already been validated with `isMarketplaceRef`.
 */
function parseRef(ref: string): {
	pluginName: string;
	owner: string;
	repo: string;
} {
	const atIdx = ref.indexOf('@');
	const pluginName = ref.slice(0, atIdx);
	const slug = ref.slice(atIdx + 1);
	const slashIdx = slug.indexOf('/');
	return {
		pluginName,
		owner: slug.slice(0, slashIdx),
		repo: slug.slice(slashIdx + 1),
	};
}

/**
 * Ensure the marketplace repo is cloned locally.
 * Only clones if repo doesn't exist. No automatic pull on startup.
 * Returns the absolute path to the cached repo directory.
 */
function ensureRepo(cacheDir: string, owner: string, repo: string): string {
	const repoDir = path.join(cacheDir, owner, repo);

	if (!fs.existsSync(repoDir)) {
		// Not cached — clone the repo
		const repoUrl = `https://github.com/${owner}/${repo}.git`;
		fs.mkdirSync(repoDir, {recursive: true});

		try {
			execFileSync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
				stdio: 'ignore',
			});
		} catch (error) {
			// Clean up partial clone
			fs.rmSync(repoDir, {recursive: true, force: true});
			throw new Error(
				`Failed to clone marketplace repo ${owner}/${repo}: ${(error as Error).message}`,
			);
		}
	} else {
		// Cached — pull latest, but don't fail startup if offline
		try {
			execFileSync('git', ['pull', '--ff-only'], {
				cwd: repoDir,
				stdio: 'ignore',
			});
		} catch {
			// Graceful degradation: use cached version if pull fails
		}
	}

	return repoDir;
}

/**
 * Pull latest changes for a cached marketplace repo.
 * Call this explicitly when user requests an update.
 */
export function pullMarketplaceRepo(owner: string, repo: string): void {
	const cacheDir = path.join(os.homedir(), '.config', 'athena', 'marketplaces');
	const repoDir = path.join(cacheDir, owner, repo);

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

/**
 * Resolve a marketplace reference to an absolute plugin directory path.
 *
 * Clones or updates the marketplace repo, reads its manifest, and returns
 * the resolved path to the requested plugin.
 */
export function resolveMarketplacePlugin(ref: string): string {
	// Verify git is available
	try {
		execFileSync('git', ['--version'], {stdio: 'ignore'});
	} catch {
		throw new Error(
			'git is not installed. Install git to use marketplace plugins.',
		);
	}

	const {pluginName, owner, repo} = parseRef(ref);
	const cacheDir = path.join(os.homedir(), '.config', 'athena', 'marketplaces');
	const repoDir = ensureRepo(cacheDir, owner, repo);
	return resolvePluginDirFromManifest(
		pluginName,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export function resolveMarketplacePluginFromRepo(
	ref: string,
	repoDir: string,
): string {
	const {pluginName} = parseRef(ref);
	return resolvePluginDirFromManifest(
		pluginName,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

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

export function listMarketplaceWorkflows(
	owner: string,
	repo: string,
): MarketplaceWorkflowListing[] {
	try {
		execFileSync('git', ['--version'], {stdio: 'ignore'});
	} catch {
		throw new Error(
			'git is not installed. Install git to use marketplace workflows.',
		);
	}

	const cacheDir = path.join(os.homedir(), '.config', 'athena', 'marketplaces');
	const repoDir = ensureRepo(cacheDir, owner, repo);
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

/**
 * Resolve a marketplace workflow reference to an absolute workflow.json path.
 */
export function resolveMarketplaceWorkflow(ref: string): string {
	try {
		execFileSync('git', ['--version'], {stdio: 'ignore'});
	} catch {
		throw new Error(
			'git is not installed. Install git to use marketplace workflows.',
		);
	}

	const {pluginName: workflowName, owner, repo} = parseRef(ref);
	const cacheDir = path.join(os.homedir(), '.config', 'athena', 'marketplaces');
	const repoDir = ensureRepo(cacheDir, owner, repo);
	return resolveWorkflowPathFromManifest(
		workflowName,
		repoDir,
		resolveWorkflowManifestPath(repoDir),
	);
}
