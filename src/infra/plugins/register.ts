/**
 * Plugin registration orchestrator.
 *
 * Loads each plugin directory, registers the resulting commands,
 * and merges MCP server configs from all plugins into a single file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {register} from '../../app/commands/registry';
import {loadPlugin} from './loader';
import type {WorkflowConfig} from '../../core/workflows/types';
import type {McpServerChoices} from './config';

export type PluginRegistrationResult = {
	mcpConfig?: string;
	workflows: WorkflowConfig[];
};

export function buildPluginMcpConfig(
	pluginDirs: string[],
	mcpServerOptions?: McpServerChoices,
): string | undefined {
	const mergedServers: Record<string, Record<string, unknown>> = {};

	for (const dir of pluginDirs) {
		const mcpPath = path.join(dir, '.mcp.json');
		if (!fs.existsSync(mcpPath)) {
			continue;
		}

		const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as {
			mcpServers?: Record<string, Record<string, unknown>>;
		};

		for (const [serverName, serverConfig] of Object.entries(
			config.mcpServers ?? {},
		)) {
			if (serverName in mergedServers) {
				throw new Error(
					`MCP server name collision: "${serverName}" is defined by multiple plugins. ` +
						'Each MCP server must have a unique name across all plugins.',
				);
			}

			const {options: _options, ...rest} = serverConfig;

			if (mcpServerOptions && serverName in mcpServerOptions) {
				rest.args = mcpServerOptions[serverName];
			}

			mergedServers[serverName] = rest;
		}
	}

	if (Object.keys(mergedServers).length === 0) {
		return undefined;
	}

	const mcpConfig = path.join(os.tmpdir(), `athena-mcp-${process.pid}.json`);
	fs.writeFileSync(mcpConfig, JSON.stringify({mcpServers: mergedServers}));
	return mcpConfig;
}

/**
 * Load plugins from the given directories, register their commands,
 * and return merged MCP config + discovered workflows.
 *
 * When `mcpServerOptions` is provided, matching server entries get their
 * `args` replaced with the user's chosen args. The `options` field is
 * always stripped before writing — Claude Code doesn't understand it.
 */
export function registerPlugins(
	pluginDirs: string[],
	mcpServerOptions?: McpServerChoices,
	includeMcpConfig = true,
): PluginRegistrationResult {
	const workflows: WorkflowConfig[] = [];

	for (const dir of pluginDirs) {
		const commands = loadPlugin(dir);
		for (const command of commands) {
			register(command);
		}

		// Discover workflow config
		const workflowPath = path.join(dir, 'workflow.json');
		if (fs.existsSync(workflowPath)) {
			const workflow = JSON.parse(
				fs.readFileSync(workflowPath, 'utf-8'),
			) as WorkflowConfig;
			workflows.push(workflow);
		}
	}

	const mcpConfig = includeMcpConfig
		? buildPluginMcpConfig(pluginDirs, mcpServerOptions)
		: undefined;

	return {mcpConfig, workflows};
}
