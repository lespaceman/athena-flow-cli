/**
 * Standalone workflow registry.
 *
 * Manages workflow.json files in ~/.config/athena/workflows/.
 * Each workflow is stored as {name}/workflow.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	isMarketplaceRef,
	resolveMarketplaceWorkflow,
	type ResolvedWorkflowSource,
} from '../../infra/plugins/marketplace';
import type {
	ResolvedWorkflowConfig,
	WorkflowConfig,
	WorkflowSourceMetadata,
} from './types';
import {refreshPinnedWorkflowPlugins} from './installer';
import {resolveBuiltinWorkflow, listBuiltinWorkflows} from './builtins/index';
import {
	readWorkflowSourceMetadata,
	writeWorkflowSourceMetadata,
} from './sourceMetadata';

function registryDir(): string {
	return path.join(os.homedir(), '.config', 'athena', 'workflows');
}

function ensurePathWithinRoot(
	rootDir: string,
	targetPath: string,
	label: string,
): void {
	const relative = path.relative(rootDir, targetPath);
	if (
		relative === '' ||
		(!relative.startsWith('..') && !path.isAbsolute(relative))
	) {
		return;
	}

	throw new Error(`${label} resolves outside the workflow root: ${targetPath}`);
}

/**
 * Resolve a workflow by name from the registry.
 * Throws if the workflow is not installed.
 */
export function resolveWorkflow(name: string): ResolvedWorkflowConfig {
	const workflowDir = path.join(registryDir(), name);
	const workflowPath = path.join(workflowDir, 'workflow.json');

	if (!fs.existsSync(workflowPath)) {
		const builtin = resolveBuiltinWorkflow(name);
		if (builtin) {
			return builtin;
		}

		throw new Error(
			`Workflow "${name}" not found. Install with: athena workflow install <source> --name ${name}`,
		);
	}

	const source = readWorkflowSourceMetadata(workflowDir);

	const raw = JSON.parse(fs.readFileSync(workflowPath, 'utf-8')) as Record<
		string,
		unknown
	>;

	if (!Array.isArray(raw['plugins'])) {
		throw new Error(
			`Invalid workflow.json: "plugins" must be an array (got ${typeof raw['plugins']})`,
		);
	}

	for (const entry of raw['plugins'] as unknown[]) {
		if (typeof entry === 'string') {
			if (isMarketplaceRef(entry.trim())) {
				continue;
			}
			throw new Error(
				`Invalid workflow.json: each plugin must be a valid marketplace ref string or {ref, version} object`,
			);
		}
		if (typeof entry === 'object' && entry !== null) {
			const r = (entry as Record<string, unknown>)['ref'];
			const v = (entry as Record<string, unknown>)['version'];
			if (
				typeof r === 'string' &&
				isMarketplaceRef(r.trim()) &&
				r.trim().length > 0 &&
				typeof v === 'string' &&
				v.trim().length > 0
			) {
				continue;
			}
		}
		throw new Error(
			`Invalid workflow.json: each plugin must be a valid marketplace ref string or {ref, version} object`,
		);
	}

	if (typeof raw['promptTemplate'] !== 'string') {
		throw new Error(`Invalid workflow.json: "promptTemplate" must be a string`);
	}

	if (
		raw['examplePrompts'] !== undefined &&
		(!Array.isArray(raw['examplePrompts']) ||
			!raw['examplePrompts'].every((e: unknown) => typeof e === 'string'))
	) {
		throw new Error(
			`Invalid workflow.json: "examplePrompts" must be an array of strings`,
		);
	}

	if (
		typeof raw['workflowFile'] !== 'string' ||
		raw['workflowFile'].length === 0
	) {
		throw new Error(
			'Invalid workflow.json: "workflowFile" is required and must point to the workflow instructions file',
		);
	}

	// Resolve workflowFile relative to workflow directory when present.
	const workflowFile = raw['workflowFile'];
	if (typeof workflowFile === 'string' && !path.isAbsolute(workflowFile)) {
		const workflowFilePath = path.resolve(workflowDir, workflowFile);
		if (!fs.existsSync(workflowFilePath)) {
			throw new Error(
				`Invalid workflow.json: workflowFile "${workflowFile}" not found at ${workflowFilePath}`,
			);
		}
		raw['workflowFile'] = workflowFilePath;
	} else if (typeof workflowFile === 'string' && !fs.existsSync(workflowFile)) {
		throw new Error(
			`Invalid workflow.json: workflowFile "${workflowFile}" not found`,
		);
	}

	return {
		...(raw as WorkflowConfig),
		...(source ? {__source: source} : {}),
	};
}

/**
 * Read a workflow source file and return its raw content and parsed config.
 */
function readWorkflowSource(sourcePath: string): {
	content: string;
	workflow: WorkflowConfig;
} {
	const content = fs.readFileSync(sourcePath, 'utf-8');
	return {content, workflow: JSON.parse(content) as WorkflowConfig};
}

/**
 * Copy workflow.json and referenced assets from a source path into a
 * destination directory. Shared by installWorkflow and syncFromMarketplace.
 */
function copyWorkflowFiles(sourcePath: string, destDir: string): void {
	const {content, workflow} = readWorkflowSource(sourcePath);
	const absoluteSourcePath = path.resolve(sourcePath);
	const sourceDir = path.dirname(absoluteSourcePath);
	const absoluteDestDir = path.resolve(destDir);

	fs.mkdirSync(absoluteDestDir, {recursive: true});
	fs.writeFileSync(
		path.join(absoluteDestDir, 'workflow.json'),
		content,
		'utf-8',
	);

	// Copy referenced local assets next to workflow.json when available.
	const copyRelativeAsset = (assetPath: string | undefined) => {
		if (!assetPath || path.isAbsolute(assetPath)) return;
		const sourceAssetPath = path.resolve(sourceDir, assetPath);
		ensurePathWithinRoot(sourceDir, sourceAssetPath, 'Workflow asset');
		if (!fs.existsSync(sourceAssetPath)) return;
		const destAssetPath = path.resolve(absoluteDestDir, assetPath);
		ensurePathWithinRoot(absoluteDestDir, destAssetPath, 'Workflow asset');
		fs.mkdirSync(path.dirname(destAssetPath), {recursive: true});
		fs.copyFileSync(sourceAssetPath, destAssetPath);
	};
	const rawWorkflow = workflow as Record<string, unknown>;
	const promptAsset = rawWorkflow['workflowFile'];
	if (typeof promptAsset !== 'string' || promptAsset.length === 0) {
		throw new Error(
			'Invalid workflow.json: "workflowFile" is required and must point to the workflow instructions file',
		);
	}
	copyRelativeAsset(promptAsset);
}

/**
 * Install a workflow from a local file path.
 * Copies the workflow.json into the registry under the given name.
 */
export function installWorkflow(source: string, name?: string): string {
	const isMarketplace = isMarketplaceRef(source);

	// Resolve marketplace ref to local path
	const sourcePath = isMarketplace
		? resolveMarketplaceWorkflow(source)
		: source;

	const {workflow} = readWorkflowSource(sourcePath);
	const workflowName = name ?? workflow.name;

	if (!workflowName) {
		throw new Error(
			'Workflow has no "name" field. Provide --name to specify one.',
		);
	}

	const destDir = path.join(registryDir(), workflowName);
	copyWorkflowFiles(sourcePath, destDir);

	const metadata: WorkflowSourceMetadata = isMarketplace
		? {kind: 'marketplace-remote', ref: source}
		: {kind: 'filesystem', path: path.resolve(sourcePath)};
	writeWorkflowSourceMetadata(destDir, metadata);

	return workflowName;
}

function toStoredMetadata(
	source: ResolvedWorkflowSource,
): WorkflowSourceMetadata {
	if (source.kind === 'marketplace-remote') {
		return {
			kind: 'marketplace-remote',
			ref: source.ref,
			...(source.version ? {version: source.version} : {}),
		};
	}
	if (source.kind === 'marketplace-local') {
		return {
			kind: 'marketplace-local',
			repoDir: source.repoDir,
			workflowName: source.workflowName,
			...(source.version ? {version: source.version} : {}),
		};
	}
	return {kind: 'filesystem', path: source.workflowPath};
}

export function installWorkflowFromSource(
	source: ResolvedWorkflowSource,
	name?: string,
): string {
	const {workflow} = readWorkflowSource(source.workflowPath);
	const workflowName = name ?? workflow.name;
	if (!workflowName) {
		throw new Error(
			'Workflow has no "name" field. Provide --name to specify one.',
		);
	}
	const destDir = path.join(registryDir(), workflowName);
	copyWorkflowFiles(source.workflowPath, destDir);

	const metadata = toStoredMetadata(source);
	writeWorkflowSourceMetadata(destDir, metadata);
	return workflowName;
}

export function updateWorkflow(name: string): string {
	const workflowDir = path.join(registryDir(), name);
	const source = readWorkflowSourceMetadata(workflowDir);

	if (!source) {
		throw new Error(
			`Workflow "${name}" has no recorded source. Reinstall it with: athena-flow workflow install <source>`,
		);
	}

	// Task 10 will route marketplace-local through installWorkflowFromSource.
	// For now, only marketplace-remote and filesystem have a direct installWorkflow path.
	const installSource =
		source.kind === 'marketplace-remote'
			? source.ref
			: source.kind === 'filesystem'
				? source.path
				: (() => {
						throw new Error(
							`Workflow "${name}" uses a marketplace-local source. Use \`athena-flow workflow install\` to reinstall it.`,
						);
					})();
	const installedName = installWorkflow(installSource, name);
	refreshPinnedWorkflowPlugins(resolveWorkflow(installedName));
	return installedName;
}

/**
 * List all installed workflow names.
 */
export function listWorkflows(): string[] {
	const dir = registryDir();
	const installed = fs.existsSync(dir)
		? fs
				.readdirSync(dir, {withFileTypes: true})
				.filter(
					entry =>
						entry.isDirectory() &&
						fs.existsSync(path.join(dir, entry.name, 'workflow.json')),
				)
				.map(entry => entry.name)
		: [];

	const builtins = listBuiltinWorkflows().filter(
		name => !installed.includes(name),
	);

	return [...builtins, ...installed];
}

/**
 * Remove a workflow from the registry.
 * Throws if the workflow is not installed.
 */
export function removeWorkflow(name: string): void {
	const dir = path.join(registryDir(), name);

	if (!fs.existsSync(dir)) {
		throw new Error(`Workflow "${name}" not found.`);
	}

	fs.rmSync(dir, {recursive: true, force: true});
}
