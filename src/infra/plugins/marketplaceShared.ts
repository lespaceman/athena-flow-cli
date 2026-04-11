import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
	CodexWorkflowPluginRef,
	ResolvedLocalWorkflowPlugin,
} from '../../core/workflows/types';

/**
 * Result of resolving a marketplace plugin ref. `pluginDir` is the Claude
 * artifact directory; `codexPluginDir` is the Codex artifact directory, which
 * differs from `pluginDir` only for packaged plugins with split Claude/Codex
 * layouts.
 */
export type MarketplacePluginTarget = CodexWorkflowPluginRef &
	ResolvedLocalWorkflowPlugin & {
		codexPluginDir: string;
	};

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

type PackagedArtifactLayout = {
	claudeArtifactDir: string;
	codexMarketplacePath: string;
	codexPluginDir: string;
};

type ReleaseArtifactManifest = {
	version: string;
	artifacts?: {
		claude?: {path?: string};
		codex?: {marketplacePath?: string; pluginPath?: string};
	};
};

export function marketplacesCacheDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'marketplaces');
}

export function marketplaceRepoCacheDir(owner: string, repo: string): string {
	return path.join(marketplacesCacheDir(), owner, repo);
}

export function resolvePluginManifestPath(repoDir: string): string {
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

export function resolveWorkflowManifestPath(repoDir: string): string {
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

export function readManifest(manifestPath: string): MarketplaceManifest {
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
export function entryRelativeSourcePath(
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

export function resolvePluginDirFromManifest(
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

function resolveWorkflowEntryPath(
	entry: MarketplaceEntry,
	manifest: MarketplaceManifest,
	repoDir: string,
): string {
	if (typeof entry.source !== 'string') {
		throw new Error(
			`Workflow "${entry.name}" uses a remote source type which is not supported.`,
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
			`Workflow "${entry.name}" source resolves outside the marketplace repo: ${workflowPath}`,
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

export function resolveWorkflowPathFromManifest(
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
	return resolveWorkflowEntryPath(entry, manifest, repoDir);
}

export function listWorkflowEntriesFromManifest(
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
			workflowPath: resolveWorkflowEntryPath(entry, manifest, repoDir),
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

export function isMarketplaceRef(entry: string): boolean {
	return MARKETPLACE_REF_RE.test(entry);
}

export function isMarketplaceSlug(entry: string): boolean {
	return MARKETPLACE_SLUG_RE.test(entry);
}

export function parseRef(ref: string): {
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

export function buildMarketplacePluginResolution(
	ref: string,
	repoDir: string,
	manifestPath: string,
): MarketplacePluginTarget {
	const {pluginName} = parseRef(ref);
	const pluginDir = resolvePluginDirFromManifest(
		pluginName,
		repoDir,
		manifestPath,
	);
	const version = resolvePluginVersionFromDir(pluginDir);
	const artifactLayout = version
		? resolvePackagedArtifactLayout(pluginDir, version)
		: undefined;
	return {
		ref,
		pluginName,
		marketplacePath: artifactLayout?.codexMarketplacePath ?? manifestPath,
		pluginDir: artifactLayout?.claudeArtifactDir ?? pluginDir,
		codexPluginDir: artifactLayout?.codexPluginDir ?? pluginDir,
	};
}

function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
	const relative = path.relative(rootDir, targetPath);
	return (
		relative === '' ||
		(!relative.startsWith('..') && !path.isAbsolute(relative))
	);
}

export function resolvePluginVersionFromDir(
	pluginDir: string,
): string | undefined {
	const manifestPaths = [
		path.join(pluginDir, '.codex-plugin', 'plugin.json'),
		path.join(pluginDir, '.claude-plugin', 'plugin.json'),
	];
	for (const manifestPath of manifestPaths) {
		if (!fs.existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
				version?: string;
			};
			if (typeof manifest.version === 'string' && manifest.version.length > 0) {
				return manifest.version;
			}
		} catch {
			// ignore malformed plugin.json and try the next candidate
		}
	}
	return undefined;
}

export function resolvePackagedArtifactLayout(
	pluginRoot: string,
	version: string,
): PackagedArtifactLayout | undefined {
	const releasePath = path.join(pluginRoot, 'dist', version, 'release.json');
	if (!fs.existsSync(releasePath)) {
		return undefined;
	}
	try {
		const release = JSON.parse(
			fs.readFileSync(releasePath, 'utf-8'),
		) as ReleaseArtifactManifest;
		if (release.version !== version) {
			return undefined;
		}
		const claudePath = release.artifacts?.claude?.path;
		const codexMarketplacePath = release.artifacts?.codex?.marketplacePath;
		const codexPluginPath = release.artifacts?.codex?.pluginPath;
		if (
			typeof claudePath !== 'string' ||
			typeof codexMarketplacePath !== 'string' ||
			typeof codexPluginPath !== 'string'
		) {
			return undefined;
		}
		const releaseDir = path.dirname(releasePath);
		const claudeArtifactDir = path.resolve(releaseDir, claudePath);
		const resolvedCodexMarketplacePath = path.resolve(
			releaseDir,
			codexMarketplacePath,
		);
		const codexPluginDir = path.resolve(releaseDir, codexPluginPath);
		if (
			!isPathWithinRoot(releaseDir, claudeArtifactDir) ||
			!isPathWithinRoot(releaseDir, resolvedCodexMarketplacePath) ||
			!isPathWithinRoot(releaseDir, codexPluginDir)
		) {
			return undefined;
		}
		if (
			!fs.existsSync(claudeArtifactDir) ||
			!fs.existsSync(resolvedCodexMarketplacePath) ||
			!fs.existsSync(codexPluginDir)
		) {
			return undefined;
		}
		return {
			claudeArtifactDir,
			codexMarketplacePath: resolvedCodexMarketplacePath,
			codexPluginDir,
		};
	} catch {
		return undefined;
	}
}

/**
 * Ensure the marketplace repo is cloned locally.
 * Only clones if repo doesn't exist. No automatic pull on startup.
 * Returns the absolute path to the cached repo directory.
 */
export function ensureRepo(owner: string, repo: string): string {
	const repoDir = marketplaceRepoCacheDir(owner, repo);

	if (!fs.existsSync(repoDir)) {
		const repoUrl = `https://github.com/${owner}/${repo}.git`;
		fs.mkdirSync(repoDir, {recursive: true});

		try {
			execFileSync('git', ['clone', '--depth', '1', repoUrl, repoDir], {
				stdio: 'ignore',
			});
		} catch (error) {
			fs.rmSync(repoDir, {recursive: true, force: true});
			throw new Error(
				`Failed to clone marketplace repo ${owner}/${repo}: ${(error as Error).message}`,
			);
		}
	} else {
		try {
			execFileSync('git', ['pull', '--ff-only'], {
				cwd: repoDir,
				stdio: 'ignore',
			});
		} catch {
			// offline or upstream diverged; fall back to the cached repo
		}
	}

	return repoDir;
}

export function requireGitForMarketplace(kind: 'plugins' | 'workflows'): void {
	try {
		execFileSync('git', ['--version'], {stdio: 'ignore'});
	} catch {
		throw new Error(
			`git is not installed. Install git to use marketplace ${kind}.`,
		);
	}
}
