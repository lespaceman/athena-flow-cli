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
	args: string[];
};

/** Server name → chosen args array */
export type McpServerChoices = Record<string, string[]>;
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
	/** Workflow marketplace source: owner/repo slug or local marketplace path */
	workflowMarketplaceSource?: string;
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
 * Read per-project plugin config from `{projectDir}/.athena/config.json`.
 * Relative paths are resolved against projectDir.
 * Returns `{ plugins: [] }` if the file does not exist.
 */
export function readConfig(projectDir: string): AthenaConfig {
	const configPath = path.join(projectDir, '.athena', 'config.json');
	return readConfigFile(configPath, projectDir);
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
		workflowMarketplaceSource?: string;
		workflowSelections?: WorkflowSelections;
		setupComplete?: boolean;
		harness?: string;
		telemetry?: boolean;
		telemetryDiagnostics?: boolean;
		deviceId?: string;
	};

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
		workflowMarketplaceSource: raw.workflowMarketplaceSource,
		workflowSelections: raw.workflowSelections,
		setupComplete: raw.setupComplete as boolean | undefined,
		harness:
			raw.harness === 'claude-code' ||
			raw.harness === 'openai-codex' ||
			raw.harness === 'opencode'
				? raw.harness
				: raw.harness === 'codex'
					? 'openai-codex'
					: undefined,
		telemetry: raw.telemetry,
		telemetryDiagnostics: raw.telemetryDiagnostics,
		deviceId: raw.deviceId,
	};
}

/**
 * Write global config to `~/.config/athena/config.json`.
 * Merges with existing config if present. Creates directories as needed.
 */
export function writeGlobalConfig(updates: Partial<AthenaConfig>): void {
	const homeDir = os.homedir();
	const configDir = path.join(homeDir, '.config', 'athena');
	const configPath = path.join(configDir, 'config.json');

	let existing: Record<string, unknown> = {};
	if (fs.existsSync(configPath)) {
		existing = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
			string,
			unknown
		>;
	}

	const merged: Record<string, unknown> = {...existing, ...updates};
	if (updates.workflowSelections) {
		const existingSelections =
			(existing['workflowSelections'] as WorkflowSelections | undefined) ?? {};
		merged['workflowSelections'] = {
			...existingSelections,
			...updates.workflowSelections,
		};
	}
	// Legacy keys from pre-workflowSelection configs are no longer valid.
	delete merged['workflow'];
	delete merged['mcpServerOptions'];
	fs.mkdirSync(configDir, {recursive: true});
	fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
