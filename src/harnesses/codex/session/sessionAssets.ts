import fs from 'node:fs';
import type {WorkflowPlan} from '../../../core/workflows';

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'object' && value !== null) {
		return value as Record<string, unknown>;
	}
	return null;
}

/**
 * Shell-quote a string using single quotes (POSIX-safe).
 * Interior single quotes are escaped as `'"'"'`.
 */
function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * When `env` is present but the codex protocol has no `env` field,
 * rewrite `command`/`args` into a shell wrapper that exports the
 * env vars before exec-ing the original command.
 */
/**
 * Session env vars that MCP servers typically need but codex does not
 * forward. Under the claude harness, child processes inherit process.env
 * automatically; here we must inject them explicitly.
 */
const SESSION_ENV_PASSTHROUGH = [
	'DISPLAY',
	'XAUTHORITY',
	'WAYLAND_DISPLAY',
	'XDG_RUNTIME_DIR',
] as const;

/**
 * Inject session-level env vars from `process.env` into the config's
 * `env` field. Explicit values in the config take precedence.
 */
function injectSessionEnv(config: Record<string, unknown>): void {
	let envObj = asRecord(config['env']);
	let injected = false;

	for (const key of SESSION_ENV_PASSTHROUGH) {
		const value = process.env[key];
		if (!value) continue;
		if (envObj && key in envObj) continue;

		if (!envObj) {
			envObj = {};
			injected = true;
		}
		envObj[key] = value;
		injected = true;
	}

	if (injected && envObj) {
		config['env'] = envObj;
	}
}

function applyEnvShellWrap(config: Record<string, unknown>): void {
	injectSessionEnv(config);

	const envObj = asRecord(config['env']);
	delete config['env'];

	if (!envObj || Object.keys(envObj).length === 0) {
		return;
	}

	const exports = Object.entries(envObj)
		.filter(([, v]) => typeof v === 'string')
		.map(([k, v]) => `export ${k}=${shellQuote(v as string)}`);

	const origCmd = String(config['command'] ?? '');
	const origArgs = Array.isArray(config['args'])
		? (config['args'] as string[]).map(a => shellQuote(String(a)))
		: [];

	const parts = [...exports, `exec ${origCmd} ${origArgs.join(' ')}`.trimEnd()];
	config['command'] = 'sh';
	config['args'] = ['-c', parts.join(' && ')];
}

function normalizeCodexMcpServerConfig(
	serverConfig: Record<string, unknown>,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(serverConfig)) {
		if (key === 'options') {
			continue;
		}

		if (key === 'bearerTokenEnvVar') {
			normalized['bearer_token_env_var'] = value;
			continue;
		}

		normalized[key] = value;
	}

	applyEnvShellWrap(normalized);

	return normalized;
}

function readMcpServers(
	configPath: string,
): Record<string, Record<string, unknown>> {
	if (!configPath) {
		return {};
	}
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, 'utf-8');
	} catch {
		return {};
	}
	const parsed = JSON.parse(raw) as {
		mcpServers?: Record<string, unknown>;
	};
	const servers = asRecord(parsed['mcpServers']);
	if (!servers) {
		return {};
	}
	const result: Record<string, Record<string, unknown>> = {};
	for (const [name, config] of Object.entries(servers)) {
		const record = asRecord(config);
		if (record) {
			result[name] = normalizeCodexMcpServerConfig(record);
		}
	}
	return result;
}

/**
 * Merge session-level plugin MCP config and workflow-derived MCP config
 * into a single Codex config object. Workflow entries take precedence
 * over session-level entries with the same server name.
 */
export function resolveCodexMcpConfig(
	pluginMcpConfig?: string,
	workflowPlan?: WorkflowPlan,
): Record<string, unknown> | undefined {
	const sessionServers = pluginMcpConfig ? readMcpServers(pluginMcpConfig) : {};
	const workflowServers = workflowPlan?.pluginMcpConfig
		? readMcpServers(workflowPlan.pluginMcpConfig)
		: {};
	const merged = {...sessionServers, ...workflowServers};
	return Object.keys(merged).length === 0 ? undefined : {mcp_servers: merged};
}

export function resolveCodexWorkflowPlugins(
	workflowPlan?: WorkflowPlan,
): Array<{
	ref: string;
	pluginName: string;
	marketplacePath: string;
	version?: string;
}> {
	return (
		workflowPlan?.resolvedPlugins.map(plugin => ({
			ref: plugin.ref,
			pluginName: plugin.pluginName,
			marketplacePath: plugin.codexMarketplacePath,
			...(plugin.version !== undefined && {version: plugin.version}),
		})) ??
		workflowPlan?.codexPlugins ??
		[]
	);
}
