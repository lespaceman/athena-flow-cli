/**
 * Plugin config reader.
 *
 * Reads global config from `~/.config/athena/config.json` and
 * per-project config from `{projectDir}/.athena/config.json`.
 * Missing files are not errors — returns empty config.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isMarketplaceRef, resolveMarketplacePlugin} from './marketplace';

export type AthenaHarness = 'claude-code' | 'openai-codex' | 'opencode';

export type McpServerOption = {
	label: string;
	env: Record<string, string>;
};

/** Server name → chosen env overrides */
export type McpServerChoices = Record<string, Record<string, string>>;
export type WorkflowSelection = {
	mcpServerOptions?: McpServerChoices;
};
export type WorkflowSelections = Record<string, WorkflowSelection>;

export type AthenaConfig = {
	plugins: string[];
	/** Additional directories to grant Claude access to (passed as --add-dir flags) */
	additionalDirectories: string[];
	/** Model to use (alias like "sonnet"/"opus" or full model ID) */
	model?: string;
	/** Color theme: 'dark' or 'light' */
	theme?: string;
	/** Globally selected workflow name */
	activeWorkflow?: string;
	/** Workflow marketplace sources: owner/repo slugs or local marketplace paths */
	workflowMarketplaceSources?: string[];
	/** Per-workflow saved selections (for MCP option args, etc.) */
	workflowSelections?: WorkflowSelections;
	/** Whether the setup wizard has been completed */
	setupComplete?: boolean;
	/** Which AI coding harness is being used */
	harness?: AthenaHarness;
	/** Whether anonymous telemetry is enabled (default: true, opt-out) */
	telemetry?: boolean;
	/** Whether anonymous startup diagnostics may be sent after explicit consent */
	telemetryDiagnostics?: boolean;
	/** Anonymous device identifier (UUIDv4, not tied to user identity) */
	deviceId?: string;
};

const EMPTY_CONFIG: AthenaConfig = {plugins: [], additionalDirectories: []};

/**
 * Absolute path to a project's `.athena/config.json` file.
 */
export function projectConfigPath(projectDir: string): string {
	return path.join(projectDir, '.athena', 'config.json');
}

/**
 * Read per-project plugin config from `{projectDir}/.athena/config.json`.
 * Relative paths are resolved against projectDir.
 * Returns `{ plugins: [] }` if the file does not exist.
 */
export function readConfig(projectDir: string): AthenaConfig {
	return readConfigFile(projectConfigPath(projectDir), projectDir);
}

/**
 * Origin layer of an active workflow selection.
 */
export type ActiveWorkflowSource =
	| 'override'
	| 'project'
	| 'global'
	| 'default';

export type ActiveWorkflowResolution = {
	name: string;
	source: ActiveWorkflowSource;
	/**
	 * Layer that supplies workflowSelections (MCP option overrides) for this
	 * workflow. A `--workflow` CLI override only changes which workflow runs;
	 * its option overrides still come from whichever layer would otherwise
	 * have selected the workflow.
	 */
	selectionsLayer: AthenaConfig;
};

/**
 * Resolve the active workflow name + source layer from configs and an
 * optional CLI override. Single source of truth for workflow precedence;
 * used by bootstrap, dry-run summary, and `workflow status`.
 */
export function resolveActiveWorkflow(input: {
	globalConfig: AthenaConfig;
	projectConfig: AthenaConfig;
	override?: string;
}): ActiveWorkflowResolution {
	const {globalConfig, projectConfig, override} = input;
	if (override !== undefined) {
		return {
			name: override,
			source: 'override',
			selectionsLayer:
				projectConfig.activeWorkflow !== undefined
					? projectConfig
					: globalConfig,
		};
	}
	if (projectConfig.activeWorkflow !== undefined) {
		return {
			name: projectConfig.activeWorkflow,
			source: 'project',
			selectionsLayer: projectConfig,
		};
	}
	if (globalConfig.activeWorkflow !== undefined) {
		return {
			name: globalConfig.activeWorkflow,
			source: 'global',
			selectionsLayer: globalConfig,
		};
	}
	return {
		name: 'default',
		source: 'default',
		selectionsLayer: globalConfig,
	};
}

/**
 * Read global plugin config from `~/.config/athena/config.json`.
 * Relative paths are resolved against the user's home directory.
 * Returns `{ plugins: [] }` if the file does not exist.
 */
export function readGlobalConfig(): AthenaConfig {
	const homeDir = os.homedir();
	const configPath = path.join(homeDir, '.config', 'athena', 'config.json');
	return readConfigFile(configPath, homeDir);
}

function readConfigFile(configPath: string, baseDir: string): AthenaConfig {
	if (!fs.existsSync(configPath)) {
		return EMPTY_CONFIG;
	}

	const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
		plugins?: string[];
		additionalDirectories?: string[];
		model?: string;
		theme?: string;
		activeWorkflow?: string;
		workflowMarketplaceSources?: string[];
		workflowSelections?: WorkflowSelections;
		setupComplete?: boolean;
		harness?: string;
		telemetry?: boolean;
		telemetryDiagnostics?: boolean;
		deviceId?: string;
	};

	if ('workflowMarketplaceSource' in (raw as Record<string, unknown>)) {
		throw new Error(
			`Invalid config: "${configPath}" uses deprecated "workflowMarketplaceSource"; use "workflowMarketplaceSources"`,
		);
	}
	if (
		raw.workflowMarketplaceSources !== undefined &&
		(!Array.isArray(raw.workflowMarketplaceSources) ||
			!raw.workflowMarketplaceSources.every(
				(source): source is string => typeof source === 'string',
			))
	) {
		throw new Error(
			`Invalid config: "${configPath}" field "workflowMarketplaceSources" must be an array of strings`,
		);
	}
	if (
		raw.harness !== undefined &&
		raw.harness !== 'claude-code' &&
		raw.harness !== 'openai-codex' &&
		raw.harness !== 'opencode'
	) {
		throw new Error(
			`Invalid config: "${configPath}" field "harness" must be one of claude-code, openai-codex, opencode`,
		);
	}

	const plugins = (raw.plugins ?? [])
		.map((p): string | null => {
			if (isMarketplaceRef(p)) {
				try {
					return resolveMarketplacePlugin(p);
				} catch (error) {
					console.error(
						`Warning: skipping plugin "${p}": ${(error as Error).message}`,
					);
					return null;
				}
			}
			return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
		})
		.filter((p): p is string => p !== null);

	// Resolve relative paths for additional directories
	const additionalDirectories = (raw.additionalDirectories ?? []).map(dir =>
		path.isAbsolute(dir) ? dir : path.resolve(baseDir, dir),
	);

	return {
		plugins,
		additionalDirectories,
		model: raw.model,
		theme: raw.theme,
		activeWorkflow: raw.activeWorkflow,
		workflowMarketplaceSources: raw.workflowMarketplaceSources,
		workflowSelections: raw.workflowSelections,
		setupComplete: raw.setupComplete as boolean | undefined,
		harness: raw.harness,
		telemetry: raw.telemetry,
		telemetryDiagnostics: raw.telemetryDiagnostics,
		deviceId: raw.deviceId,
	};
}

function readExistingConfig(configPath: string): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

function writeConfigFile(
	configDir: string,
	configPath: string,
	updates: Partial<AthenaConfig>,
	deleteKeys?: string[],
): void {
	const existing = readExistingConfig(configPath);
	const merged: Record<string, unknown> = {...existing, ...updates};
	if (updates.workflowSelections) {
		const existingSelections =
			(existing['workflowSelections'] as WorkflowSelections | undefined) ?? {};
		merged['workflowSelections'] = {
			...existingSelections,
			...updates.workflowSelections,
		};
	}
	if (deleteKeys) {
		for (const key of deleteKeys) {
			delete merged[key];
		}
	}
	fs.mkdirSync(configDir, {recursive: true});
	fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

// Legacy keys from pre-workflowSelection configs.
const GLOBAL_CONFIG_LEGACY_KEYS = [
	'workflow',
	'mcpServerOptions',
	'workflowMarketplaceSource',
];

/**
 * Write global config to `~/.config/athena/config.json`.
 * Merges with existing config if present. Creates directories as needed.
 */
export function writeGlobalConfig(updates: Partial<AthenaConfig>): void {
	const homeDir = os.homedir();
	const configDir = path.join(homeDir, '.config', 'athena');
	const configPath = path.join(configDir, 'config.json');
	writeConfigFile(configDir, configPath, updates, GLOBAL_CONFIG_LEGACY_KEYS);
}

/**
 * Write project config to `{projectDir}/.athena/config.json`.
 * Merges with existing config if present. Creates directories as needed.
 */
export function writeProjectConfig(
	projectDir: string,
	updates: Partial<AthenaConfig>,
): void {
	const configDir = path.join(projectDir, '.athena');
	const configPath = path.join(configDir, 'config.json');
	writeConfigFile(configDir, configPath, updates);
}

function hasActiveWorkflow(configPath: string): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
			activeWorkflow?: string;
		};
		return typeof raw.activeWorkflow === 'string' && raw.activeWorkflow !== '';
	} catch {
		return false;
	}
}

/**
 * Check whether a project-level config has an active workflow selected.
 */
export function hasProjectWorkflow(projectDir: string): boolean {
	return hasActiveWorkflow(projectConfigPath(projectDir));
}

/**
 * Check whether the global config has an active workflow selected.
 */
export function hasGlobalWorkflow(): boolean {
	return hasActiveWorkflow(
		path.join(os.homedir(), '.config', 'athena', 'config.json'),
	);
}
