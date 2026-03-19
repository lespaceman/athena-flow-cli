import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	parseSimpleYaml,
	splitFrontmatter,
} from '../../../shared/utils/yamlFrontmatter';

/**
 * Agent config bridge: Claude plugin agents/*.md → Codex agent roles.
 *
 * Claude defines agents as markdown files with YAML frontmatter.
 * Codex requires `[agents.<name>]` in config.toml pointing to separate
 * TOML config files. This module bridges the two formats.
 */

export type ParsedAgent = {
	name: string;
	description: string;
	developerInstructions: string;
	model?: string;
	tools?: string[];
	disallowedTools?: string[];
	permissionMode?: string;
};

export type AgentConfigEdit = {
	keyPath: string;
	value: unknown;
	mergeStrategy: 'replace' | 'upsert';
};

export type CodexAgentConfigResult = {
	agentConfigEdits: AgentConfigEdit[];
	tempDir: string;
	agentNames: string[];
	errors: AgentConfigError[];
};

export type AgentConfigError = {
	path: string;
	message: string;
};

/**
 * Map Claude model aliases to Codex agent config model field.
 *
 * Claude agents use aliases like 'sonnet', 'opus', 'haiku', 'inherit'.
 * Codex uses deployment-specific model names (e.g. 'gpt-5.3-codex').
 * We pass through as-is and let the Codex binary resolve the model:
 * - 'inherit' / undefined → omitted from TOML, inherits parent model
 * - Recognized Codex model → used directly
 * - Unrecognized name → Codex falls back to default model
 *
 * A static mapping table was considered but rejected because model names
 * change across Codex deployments. If this becomes a friction point,
 * we can add a model/list RPC lookup for closest-match resolution.
 */
function mapModelForCodex(model?: string): string | undefined {
	if (!model || model === 'inherit') {
		return undefined;
	}
	return model;
}

/**
 * Map Claude permissionMode → Codex sandbox_mode.
 */
function mapSandboxMode(permissionMode?: string): string | undefined {
	switch (permissionMode) {
		case 'plan':
			return 'read-only';
		case 'bypassPermissions':
		case 'dontAsk':
		case undefined:
		default:
			return undefined;
	}
}

/**
 * Parse a YAML frontmatter block from an agent .md file.
 * Uses the shared YAML parser from yamlFrontmatter.ts.
 */
export function parseAgentFrontmatter(content: string): {
	frontmatter: Record<string, string | boolean | string[]>;
	body: string;
} {
	const {yamlLines, body} = splitFrontmatter(content, 'Agent .md');
	const frontmatter = parseSimpleYaml(yamlLines);
	return {frontmatter, body};
}

/**
 * Parse a Claude agent .md file into a structured ParsedAgent.
 */
export function parseAgentMd(filePath: string, content: string): ParsedAgent {
	const {frontmatter, body} = parseAgentFrontmatter(content);

	const name =
		typeof frontmatter['name'] === 'string' ? frontmatter['name'] : undefined;
	if (!name) {
		throw new Error(
			`Agent file ${filePath} missing required "name" field in frontmatter`,
		);
	}
	if (!AGENT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Agent file ${filePath} has invalid name "${name}": must match [a-zA-Z0-9_-]`,
		);
	}

	const description =
		typeof frontmatter['description'] === 'string'
			? frontmatter['description']
			: undefined;
	if (!description) {
		throw new Error(
			`Agent file ${filePath} missing required "description" field in frontmatter`,
		);
	}

	const rawTools = frontmatter['tools'];
	const tools = Array.isArray(rawTools)
		? rawTools
		: typeof rawTools === 'string'
			? rawTools
					.split(',')
					.map(t => t.trim())
					.filter(Boolean)
			: undefined;

	const rawDisallowed = frontmatter['disallowedTools'];
	const disallowedTools = Array.isArray(rawDisallowed)
		? rawDisallowed
		: typeof rawDisallowed === 'string'
			? rawDisallowed
					.split(',')
					.map(t => t.trim())
					.filter(Boolean)
			: undefined;

	return {
		name,
		description,
		developerInstructions: body,
		model:
			typeof frontmatter['model'] === 'string'
				? frontmatter['model']
				: undefined,
		tools,
		disallowedTools,
		permissionMode:
			typeof frontmatter['permissionMode'] === 'string'
				? frontmatter['permissionMode']
				: undefined,
	};
}

/** Valid agent name pattern: lowercase, digits, hyphens, underscores. */
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Escape a TOML multi-line basic string value.
 * Handles `"""` sequences inside the content by inserting a backslash escape.
 */
function tomlString(value: string): string {
	const escaped = value.replace(/"""/g, '""\\"');
	return `"""\n${escaped}\n"""`;
}

/**
 * Generate a Codex agent config TOML file from a ParsedAgent.
 */
export function generateAgentToml(agent: ParsedAgent): string {
	const lines: string[] = [];

	const model = mapModelForCodex(agent.model);
	if (model) {
		lines.push(`model = "${model}"`);
	}

	const sandboxMode = mapSandboxMode(agent.permissionMode);
	if (sandboxMode) {
		lines.push(`sandbox_mode = "${sandboxMode}"`);
	}

	if (agent.developerInstructions) {
		lines.push(
			`developer_instructions = ${tomlString(agent.developerInstructions)}`,
		);
	}

	return lines.join('\n');
}

/**
 * Scan agent roots for agent .md files and return all discovered agents.
 */
export function discoverAgents(agentRoots: string[]): {
	agents: Array<{filePath: string; agent: ParsedAgent}>;
	errors: AgentConfigError[];
} {
	const agents: Array<{filePath: string; agent: ParsedAgent}> = [];
	const errors: AgentConfigError[] = [];

	for (const root of agentRoots) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(root, {withFileTypes: true});
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.md')) {
				continue;
			}

			const filePath = path.join(root, entry.name);
			try {
				const content = fs.readFileSync(filePath, 'utf-8');
				const agent = parseAgentMd(filePath, content);
				agents.push({filePath, agent});
			} catch (err) {
				errors.push({
					path: filePath,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	return {agents, errors};
}

type CollisionResult = {
	errors: AgentConfigError[];
	collidingNames: Set<string>;
};

/**
 * Detect agent name collisions across plugins.
 * Returns both errors and the set of colliding names for filtering.
 */
function detectCollisions(
	agents: Array<{filePath: string; agent: ParsedAgent}>,
): CollisionResult {
	const seen = new Map<string, string>();
	const errors: AgentConfigError[] = [];
	const collidingNames = new Set<string>();

	for (const {filePath, agent} of agents) {
		const existing = seen.get(agent.name);
		if (existing) {
			errors.push({
				path: filePath,
				message: `Agent name "${agent.name}" collides with ${existing}`,
			});
			collidingNames.add(agent.name);
		} else {
			seen.set(agent.name, filePath);
		}
	}

	return {errors, collidingNames};
}

/**
 * Resolve agent config from plugin agent roots into Codex-compatible
 * config/batchWrite edits and temp TOML files.
 *
 * Returns undefined if no agents are found.
 */
export function resolveCodexAgentConfig(input: {
	agentRoots: string[];
	sessionId: string;
}): CodexAgentConfigResult | undefined {
	const {agentRoots, sessionId} = input;
	if (agentRoots.length === 0) {
		return undefined;
	}

	const {agents, errors} = discoverAgents(agentRoots);
	const collisions = detectCollisions(agents);
	const allErrors = [...errors, ...collisions.errors];

	// Filter out collision duplicates (keep first occurrence)
	const uniqueAgents = agents.filter(({agent}, index) => {
		if (!collisions.collidingNames.has(agent.name)) {
			return true;
		}
		// Keep the first occurrence of a colliding name
		return agents.findIndex(a => a.agent.name === agent.name) === index;
	});

	if (uniqueAgents.length === 0) {
		if (allErrors.length === 0) {
			return undefined;
		}
		return {
			agentConfigEdits: [],
			tempDir: '',
			agentNames: [],
			errors: allErrors,
		};
	}

	// Create temp directory for agent TOML files
	const tempDir = path.join(os.tmpdir(), `athena-agents-${sessionId}`);
	fs.mkdirSync(tempDir, {recursive: true});

	const edits: AgentConfigEdit[] = [
		{
			keyPath: 'features.multi_agent',
			value: true,
			mergeStrategy: 'replace',
		},
		{
			keyPath: 'agents.max_threads',
			value: 6,
			mergeStrategy: 'replace',
		},
		{
			keyPath: 'agents.max_depth',
			value: 1,
			mergeStrategy: 'replace',
		},
	];

	const agentNames: string[] = [];

	for (const {agent} of uniqueAgents) {
		const toml = generateAgentToml(agent);
		const tomlPath = path.join(tempDir, `${agent.name}.toml`);
		fs.writeFileSync(tomlPath, toml, 'utf-8');

		edits.push({
			keyPath: `agents.${agent.name}`,
			value: {
				description: agent.description,
				config_file: tomlPath,
			},
			mergeStrategy: 'upsert',
		});

		agentNames.push(agent.name);
	}

	return {
		agentConfigEdits: edits,
		tempDir,
		agentNames,
		errors: allErrors,
	};
}

/**
 * Build config/batchWrite edits that remove previously loaded agent entries.
 * Uses `mergeStrategy: 'replace'` with `null` value to delete keys.
 */
export function buildAgentRemovalEdits(
	agentNames: string[],
): AgentConfigEdit[] {
	if (agentNames.length === 0) {
		return [];
	}

	const edits: AgentConfigEdit[] = agentNames.map(name => ({
		keyPath: `agents.${name}`,
		value: null,
		mergeStrategy: 'replace' as const,
	}));

	// Also disable multi_agent when removing all agents
	edits.push({
		keyPath: 'features.multi_agent',
		value: false,
		mergeStrategy: 'replace',
	});

	return edits;
}

/**
 * Clean up temp TOML files and remove agent config entries.
 */
export function cleanupAgentConfig(tempDir: string): void {
	if (!tempDir) {
		return;
	}
	try {
		fs.rmSync(tempDir, {recursive: true, force: true});
	} catch {
		// Best-effort cleanup
	}
}
