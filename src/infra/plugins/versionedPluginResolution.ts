import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	buildMarketplacePluginResolution,
	entryRelativeSourcePath,
	marketplaceRepoCacheDir,
	parseRef,
	readManifest,
	resolvePackagedArtifactLayout,
	resolvePluginManifestPath,
	resolvePluginVersionFromDir,
	type MarketplacePluginTarget,
} from './marketplaceShared';

/** Default npm scope for marketplace plugin packages. */
const PLUGIN_NPM_SCOPE = '@athenaflow';

/**
 * Derive the npm package name for a marketplace plugin.
 * Convention: `@athenaflow/plugin-{name}`.
 */
export function pluginNpmPackageName(pluginName: string): string {
	return `${PLUGIN_NPM_SCOPE}/plugin-${pluginName}`;
}

function versionedPluginCacheDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'plugin-packages');
}

export function resolveVersionedPluginDir(
	owner: string,
	repo: string,
	pluginName: string,
	version: string,
): string | undefined {
	const cacheDir = path.join(
		versionedPluginCacheDir(),
		owner,
		repo,
		pluginName,
		version,
	);
	return fs.existsSync(cacheDir) ? cacheDir : undefined;
}

function fetchPluginPackage(
	owner: string,
	repo: string,
	pluginName: string,
	version: string,
): string {
	const npmPkg = pluginNpmPackageName(pluginName);
	const destDir = path.join(
		versionedPluginCacheDir(),
		owner,
		repo,
		pluginName,
		version,
	);

	if (fs.existsSync(destDir)) {
		return destDir;
	}

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

		const extractDir = path.join(tmpDir, 'extracted');
		fs.mkdirSync(extractDir, {recursive: true});
		execFileSync('tar', ['xzf', tarballPath, '-C', extractDir], {
			stdio: 'ignore',
		});

		const packageDir = path.join(extractDir, 'package');
		if (!fs.existsSync(packageDir)) {
			throw new Error(
				'Extracted tarball does not contain a package/ directory',
			);
		}

		fs.mkdirSync(path.dirname(destDir), {recursive: true});
		try {
			fs.renameSync(packageDir, destDir);
		} catch (error) {
			const code =
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				typeof (error as {code?: unknown}).code === 'string'
					? (error as {code: string}).code
					: undefined;
			if (
				(code === 'EEXIST' || code === 'ENOTEMPTY') &&
				fs.existsSync(destDir)
			) {
				return destDir;
			}
			throw error;
		}

		return destDir;
	} finally {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	}
}

function resolvePackagedArtifactsOrThrow(
	pluginName: string,
	version: string,
	pluginRoot: string,
	stage: 'cache' | 'npm package' | 'marketplace source fallback',
) {
	const artifactLayout = resolvePackagedArtifactLayout(pluginRoot, version);
	if (!artifactLayout) {
		throw new Error(
			`${stage} for plugin "${pluginName}" version ${version} is missing packaged runtime artifacts`,
		);
	}
	return artifactLayout;
}

type SourceFallbackEntry = {
	pluginRoot: string;
	version: string | undefined;
};

function readSourceFallbackEntry(
	repoDir: string,
	pluginName: string,
): SourceFallbackEntry | undefined {
	const manifestPath = resolvePluginManifestPath(repoDir);
	const manifest = readManifest(manifestPath);
	const entry = manifest.plugins.find(plugin => plugin.name === pluginName);
	if (!entry) {
		return undefined;
	}

	const pluginRoot = path.join(
		repoDir,
		entryRelativeSourcePath(entry, pluginName),
	);
	// Prefer the manifest-level version; otherwise probe the plugin root for
	// either a Codex or Claude plugin.json (resolvePluginVersionFromDir checks
	// both).
	const version = entry.version ?? resolvePluginVersionFromDir(pluginRoot);
	return {pluginRoot, version};
}

function resolveMarketplaceSourceFallback(
	ref: string,
	pluginName: string,
	version: string,
	repoDir: string,
): MarketplacePluginTarget | undefined {
	const entry = readSourceFallbackEntry(repoDir, pluginName);
	if (!entry || entry.version !== version) {
		return undefined;
	}

	resolvePackagedArtifactsOrThrow(
		pluginName,
		version,
		entry.pluginRoot,
		'marketplace source fallback',
	);
	return buildMarketplacePluginResolution(
		ref,
		repoDir,
		resolvePluginManifestPath(repoDir),
	);
}

function describeSourceFallbackRejection(
	owner: string,
	repo: string,
	pluginName: string,
	version: string,
	repoDir: string,
): string {
	if (!fs.existsSync(repoDir)) {
		return `source fallback was unavailable because marketplace repo ${owner}/${repo} is not cached locally`;
	}

	let entry: SourceFallbackEntry | undefined;
	try {
		entry = readSourceFallbackEntry(repoDir, pluginName);
	} catch (error) {
		return `source fallback could not determine the marketplace source version: ${(error as Error).message}`;
	}

	if (!entry?.version) {
		return `source fallback was considered, but marketplace repo ${owner}/${repo} does not expose a version for plugin "${pluginName}"`;
	}

	return `source fallback was considered, but marketplace repo ${owner}/${repo} exposes version ${entry.version} instead of requested ${version}`;
}

export function resolveVersionedMarketplacePluginTarget(
	ref: string,
	version: string,
	sourceRepoDir?: string,
): MarketplacePluginTarget {
	const {pluginName, owner, repo} = parseRef(ref);

	const cachedDir = resolveVersionedPluginDir(owner, repo, pluginName, version);
	if (cachedDir) {
		const artifactLayout = resolvePackagedArtifactsOrThrow(
			pluginName,
			version,
			cachedDir,
			'cache',
		);
		return {
			ref,
			pluginName,
			marketplacePath: artifactLayout.codexMarketplacePath,
			pluginDir: artifactLayout.claudeArtifactDir,
			codexPluginDir: artifactLayout.codexPluginDir,
		};
	}

	let npmError: Error | undefined;
	try {
		const fetchedDir = fetchPluginPackage(owner, repo, pluginName, version);
		const artifactLayout = resolvePackagedArtifactsOrThrow(
			pluginName,
			version,
			fetchedDir,
			'npm package',
		);
		return {
			ref,
			pluginName,
			marketplacePath: artifactLayout.codexMarketplacePath,
			pluginDir: artifactLayout.claudeArtifactDir,
			codexPluginDir: artifactLayout.codexPluginDir,
		};
	} catch (error) {
		npmError = error as Error;
	}

	const repoDir = sourceRepoDir ?? marketplaceRepoCacheDir(owner, repo);
	const fallbackTarget = fs.existsSync(repoDir)
		? resolveMarketplaceSourceFallback(ref, pluginName, version, repoDir)
		: undefined;
	if (fallbackTarget) {
		return fallbackTarget;
	}

	const npmStageMessage = npmError
		? `npm package resolution failed for ${pluginNpmPackageName(pluginName)}@${version}: ${npmError.message}`
		: `npm package ${pluginNpmPackageName(pluginName)}@${version} was not available`;
	const fallbackMessage = describeSourceFallbackRejection(
		owner,
		repo,
		pluginName,
		version,
		repoDir,
	);

	throw new Error(
		`Plugin "${pluginName}" version ${version} could not be resolved. ${npmStageMessage}. ${fallbackMessage}.`,
	);
}
