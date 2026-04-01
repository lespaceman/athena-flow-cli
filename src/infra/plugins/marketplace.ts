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
import type {
	CodexWorkflowPluginRef,
	ResolvedLocalWorkflowPlugin,
} from '../../core/workflows/types';

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

function marketplacesCacheDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'marketplaces');
}

function marketplaceRepoCacheDir(owner: string, repo: string): string {
	return path.join(marketplacesCacheDir(), owner, repo);
}

function resolvePluginManifestPath(repoDir: string): string {
	const preferredManifestPath = path.join(
		repoDir,
		'.agents',
		'plugins',
		'marketplace.json',
	);
	const legacyManifestPath = resolveLegacyPluginManifestPath(repoDir);
	return fs.existsSync(preferredManifestPath)
		? preferredManifestPath
		: legacyManifestPath;
}

function resolveLegacyPluginManifestPath(repoDir: string): string {
	return path.join(repoDir, '.claude-plugin', 'marketplace.json');
}

function resolveWorkflowManifestPath(repoDir: string): string {
	const preferredManifestPath = path.join(
		repoDir,
		'.athena-workflow',
		'marketplace.json',
	);
	const legacyManifestPath = resolveLegacyPluginManifestPath(repoDir);
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

/**
 * Extract and validate the relative source path from a marketplace entry.
 * Returns the path without the leading `./` prefix.
 */
function entryRelativeSourcePath(
	entry: MarketplaceEntry,
	pluginName: string,
): string {
	let sourcePath: string;
	if (typeof entry.source === 'string') {
		sourcePath = entry.source;
	} else {
		const sourceRecord = entry.source;
		if (
			sourceRecord?.source !== 'local' ||
			typeof sourceRecord?.path !== 'string'
		) {
			throw new Error(
				`Plugin "${pluginName}" uses a remote source type which is not supported by athena-cli. Only local relative path sources are supported.`,
			);
		}
		sourcePath = sourceRecord.path;
	}

	if (!sourcePath.startsWith('./')) {
		throw new Error(
			`Plugin "${pluginName}" source must start with "./": ${sourcePath}`,
		);
	}

	const relativeSourcePath = sourcePath.slice(2);
	if (relativeSourcePath.length === 0) {
		throw new Error(`Plugin "${pluginName}" source must not be empty`);
	}

	if (relativeSourcePath.includes('\\')) {
		throw new Error(
			`Plugin "${pluginName}" source must stay within the marketplace root: ${sourcePath}`,
		);
	}

	const segments = relativeSourcePath.split('/');
	if (
		segments.some(
			segment => segment === '' || segment === '.' || segment === '..',
		)
	) {
		throw new Error(
			`Plugin "${pluginName}" source must stay within the marketplace root: ${sourcePath}`,
		);
	}

	return relativeSourcePath;
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

	const pluginDir = path.join(
		repoDir,
		entryRelativeSourcePath(entry, pluginName),
	);
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

function buildMarketplacePluginResolution(
	ref: string,
	repoDir: string,
	manifestPath: string,
): CodexWorkflowPluginRef & ResolvedLocalWorkflowPlugin {
	const {pluginName} = parseRef(ref);
	return {
		ref,
		pluginName,
		marketplacePath: manifestPath,
		pluginDir: resolvePluginDirFromManifest(pluginName, repoDir, manifestPath),
	};
}

/**
 * Ensure the marketplace repo is cloned locally.
 * Only clones if repo doesn't exist. No automatic pull on startup.
 * Returns the absolute path to the cached repo directory.
 */
function ensureRepo(owner: string, repo: string): string {
	const repoDir = marketplaceRepoCacheDir(owner, repo);

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
	const repoDir = ensureRepo(owner, repo);
	return resolvePluginDirFromManifest(
		pluginName,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

export function resolveMarketplacePluginTarget(
	ref: string,
): CodexWorkflowPluginRef & ResolvedLocalWorkflowPlugin {
	try {
		execFileSync('git', ['--version'], {stdio: 'ignore'});
	} catch {
		throw new Error(
			'git is not installed. Install git to use marketplace plugins.',
		);
	}

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
): CodexWorkflowPluginRef & ResolvedLocalWorkflowPlugin {
	return buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

/** Default npm scope for marketplace plugin packages. */
const PLUGIN_NPM_SCOPE = '@athenaflow';

/**
 * Derive the npm package name for a marketplace plugin.
 * Convention: `@athenaflow/plugin-{name}` (e.g. `@athenaflow/plugin-agent-web-interface`).
 */
export function pluginNpmPackageName(pluginName: string): string {
	return `${PLUGIN_NPM_SCOPE}/plugin-${pluginName}`;
}

/**
 * Local cache directory for npm-fetched versioned plugin packages.
 */
function versionedPluginCacheDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'plugin-packages');
}

/**
 * Resolve a plugin at a specific version from the local package cache.
 * Returns the cached plugin directory if the version exists, undefined otherwise.
 */
export function resolveVersionedPluginDir(
	pluginName: string,
	version: string,
): string | undefined {
	const cacheDir = path.join(versionedPluginCacheDir(), pluginName, version);
	return fs.existsSync(cacheDir) ? cacheDir : undefined;
}

/**
 * Fetch a specific plugin version from npm and cache it locally.
 * Returns the path to the unpacked plugin directory.
 */
function fetchPluginPackage(pluginName: string, version: string): string {
	const npmPkg = pluginNpmPackageName(pluginName);
	const destDir = path.join(versionedPluginCacheDir(), pluginName, version);

	if (fs.existsSync(destDir)) {
		return destDir;
	}

	// Temp dir under cache dir to ensure renameSync stays on the same filesystem
	const cacheBase = versionedPluginCacheDir();
	fs.mkdirSync(cacheBase, {recursive: true});
	const tmpDir = fs.mkdtempSync(path.join(cacheBase, '.tmp-'));
	try {
		const tarball = execFileSync(
			'npm',
			['pack', `${npmPkg}@${version}`, '--pack-destination', tmpDir],
			{encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']},
		).trim();

		const tarballPath = path.join(tmpDir, tarball);
		if (!fs.existsSync(tarballPath)) {
			throw new Error(`npm pack did not produce expected tarball: ${tarball}`);
		}

		// Extract tarball — npm pack creates a `package/` directory inside
		const extractDir = path.join(tmpDir, 'extracted');
		fs.mkdirSync(extractDir, {recursive: true});
		execFileSync('tar', ['xzf', tarballPath, '-C', extractDir], {
			stdio: 'ignore',
		});

		const packageDir = path.join(extractDir, 'package');
		if (!fs.existsSync(packageDir)) {
			throw new Error(
				`Extracted tarball does not contain a package/ directory`,
			);
		}

		// Move to versioned cache
		fs.mkdirSync(path.dirname(destDir), {recursive: true});
		fs.renameSync(packageDir, destDir);

		return destDir;
	} finally {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	}
}

/**
 * Write a synthetic marketplace manifest for a cached versioned plugin.
 *
 * Codex's plugin/install requires a marketplace manifest file on disk —
 * it cannot install from a bare plugin directory. This generates a minimal
 * manifest pointing at the cached version so Codex can install natively.
 */
function writeSyntheticCodexManifest(
	pluginName: string,
	version: string,
	pluginDir: string,
): string {
	const marketplaceRoot = path.dirname(pluginDir);
	const manifestDir = path.join(marketplaceRoot, '.agents', 'plugins');
	const manifestPath = path.join(manifestDir, 'marketplace.json');
	fs.mkdirSync(manifestDir, {recursive: true});
	fs.writeFileSync(
		manifestPath,
		JSON.stringify({
			name: `athena-versioned-${pluginName}`,
			plugins: [
				{
					name: pluginName,
					source: {source: 'local', path: `./${version}`},
				},
			],
		}) + '\n',
	);
	return manifestPath;
}

/**
 * Resolve a marketplace plugin pinned to a specific version.
 *
 * Resolution: local cache → npm registry → marketplace git repo fallback.
 */
export function resolveVersionedMarketplacePluginTarget(
	ref: string,
	version: string,
	sourceRepoDir?: string,
): CodexWorkflowPluginRef & ResolvedLocalWorkflowPlugin {
	const {pluginName, owner, repo} = parseRef(ref);

	const cachedDir = resolveVersionedPluginDir(pluginName, version);
	if (cachedDir) {
		const manifestPath = writeSyntheticCodexManifest(
			pluginName,
			version,
			cachedDir,
		);
		return {
			ref,
			pluginName,
			marketplacePath: manifestPath,
			pluginDir: cachedDir,
		};
	}

	let npmError: Error | undefined;
	try {
		const fetchedDir = fetchPluginPackage(pluginName, version);
		const manifestPath = writeSyntheticCodexManifest(
			pluginName,
			version,
			fetchedDir,
		);
		return {
			ref,
			pluginName,
			marketplacePath: manifestPath,
			pluginDir: fetchedDir,
		};
	} catch (error) {
		npmError = error as Error;
	}

	// Fall back to marketplace source if current version matches.
	// Read version from the plugin's own plugin.json (always versioned by CI),
	// because the Codex-facing marketplace manifest has no version field.
	const repoDir = sourceRepoDir ?? marketplaceRepoCacheDir(owner, repo);
	if (fs.existsSync(repoDir)) {
		const manifestPath = resolvePluginManifestPath(repoDir);
		const manifest = readManifest(manifestPath);
		const entry = manifest.plugins.find(p => p.name === pluginName);
		if (entry) {
			let currentVersion = entry.version;
			if (!currentVersion) {
				try {
					const relPath = entryRelativeSourcePath(entry, pluginName);
					const pluginJsonPath = path.join(
						repoDir,
						relPath,
						'.claude-plugin',
						'plugin.json',
					);
					const pluginMeta = JSON.parse(
						fs.readFileSync(pluginJsonPath, 'utf-8'),
					) as {version?: string};
					currentVersion = pluginMeta.version;
				} catch {
					// Source path invalid or plugin.json missing/malformed
				}
			}
			if (currentVersion === version) {
				return buildMarketplacePluginResolution(ref, repoDir, manifestPath);
			}
		}
	}

	throw new Error(
		`Plugin "${pluginName}" version ${version} not available. ` +
			(npmError
				? `npm: ${npmError.message}. `
				: `npm package ${pluginNpmPackageName(pluginName)}@${version} not found. `) +
			`Marketplace repo ${owner}/${repo} does not have this version.`,
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
	const repoDir = ensureRepo(owner, repo);
	return resolveWorkflowPathFromManifest(
		workflowName,
		repoDir,
		resolveWorkflowManifestPath(repoDir),
	);
}
