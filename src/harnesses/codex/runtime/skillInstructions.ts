import path from 'node:path';
import type {AppServerManager} from './appServerManager';
import * as M from '../protocol/methods';
import {asRecord} from './eventTranslator';
import type {WorkflowPluginTarget} from '../../../core/workflows';

export type CodexWorkflowSkill = {
	name: string;
	description?: string;
	path?: string;
	dependencySummary: string[];
};

export type CodexWorkflowSkillError = {
	path?: string;
	message: string;
};

export type CodexSkillInstructionsResult = {
	instructions?: string;
	skills: CodexWorkflowSkill[];
	errors: CodexWorkflowSkillError[];
};

function dedupeSkills(skills: CodexWorkflowSkill[]): CodexWorkflowSkill[] {
	return skills.filter(
		(skill, index, array) =>
			array.findIndex(
				candidate =>
					candidate.name === skill.name && candidate.path === skill.path,
			) === index,
	);
}

function dedupeErrors(
	errors: CodexWorkflowSkillError[],
): CodexWorkflowSkillError[] {
	return errors.filter(
		(error, index, array) =>
			array.findIndex(
				candidate =>
					candidate.message === error.message && candidate.path === error.path,
			) === index,
	);
}

function isUnderAnyRoot(filePath: string, roots: string[]): boolean {
	return roots.some(root => {
		const normalizedRoot = root.endsWith(path.sep)
			? root
			: `${root}${path.sep}`;
		return filePath === root || filePath.startsWith(normalizedRoot);
	});
}

function formatSkillDependency(tool: Record<string, unknown>): string | null {
	const type = typeof tool['type'] === 'string' ? tool['type'] : null;
	const value = typeof tool['value'] === 'string' ? tool['value'] : null;
	if (!type || !value) {
		return null;
	}

	if (type === 'mcp') {
		return `MCP server \`${value}\``;
	}

	if (type === 'env_var') {
		return `env var \`${value}\``;
	}

	return `${type} \`${value}\``;
}

function extractWorkflowSkills(
	result: unknown,
	skillRoots: string[],
): CodexWorkflowSkill[] {
	const response = asRecord(result);
	const data = Array.isArray(response['data']) ? response['data'] : [];
	return data.flatMap(entry => {
		const record = asRecord(entry);
		const skills = Array.isArray(record['skills']) ? record['skills'] : [];
		return skills
			.map(skill => asRecord(skill))
			.filter((skill): skill is Record<string, unknown> => {
				if (skill['enabled'] === false) {
					return false;
				}

				const skillPath =
					typeof skill['path'] === 'string' ? skill['path'] : null;
				return skillPath !== null && isUnderAnyRoot(skillPath, skillRoots);
			})
			.map(skill => {
				const dependencies = asRecord(skill['dependencies']);
				const tools = Array.isArray(dependencies['tools'])
					? dependencies['tools']
					: [];
				return {
					name: typeof skill['name'] === 'string' ? skill['name'] : 'unknown',
					description:
						typeof skill['description'] === 'string'
							? skill['description']
							: undefined,
					path: typeof skill['path'] === 'string' ? skill['path'] : undefined,
					dependencySummary: tools
						.map(tool => asRecord(tool))
						.map(formatSkillDependency)
						.filter((value): value is string => value !== null),
				} satisfies CodexWorkflowSkill;
			});
	});
}

function extractWorkflowSkillErrors(
	result: unknown,
): CodexWorkflowSkillError[] {
	const response = asRecord(result);
	const data = Array.isArray(response['data']) ? response['data'] : [];
	return data.flatMap(entry => {
		const record = asRecord(entry);
		const errors = Array.isArray(record['errors']) ? record['errors'] : [];
		return errors
			.map(error => asRecord(error))
			.flatMap(error => {
				const message =
					typeof error['message'] === 'string' ? error['message'] : null;
				if (!message) {
					return [];
				}
				return [
					{
						path: typeof error['path'] === 'string' ? error['path'] : undefined,
						message,
					} satisfies CodexWorkflowSkillError,
				];
			});
	});
}

function extractPluginReadSkills(result: unknown): CodexWorkflowSkill[] {
	const response = asRecord(result);
	const plugin = asRecord(response['plugin']);
	const skills = Array.isArray(plugin['skills']) ? plugin['skills'] : [];
	return skills
		.map(skill => asRecord(skill))
		.filter(
			(skill): skill is Record<string, unknown> =>
				skill['enabled'] !== false && typeof skill['name'] === 'string',
		)
		.map(skill => ({
			name: typeof skill['name'] === 'string' ? skill['name'] : 'unknown',
			description:
				typeof skill['description'] === 'string'
					? skill['description']
					: undefined,
			path: typeof skill['path'] === 'string' ? skill['path'] : undefined,
			dependencySummary: [],
		}));
}

async function readPluginWorkflowSkills(input: {
	manager: AppServerManager;
	pluginTargets: WorkflowPluginTarget[];
}): Promise<CodexWorkflowSkill[]> {
	const skills = await Promise.all(
		input.pluginTargets.map(async target => {
			const result = await input.manager.sendRequest(M.PLUGIN_READ, {
				marketplacePath: target.marketplacePath,
				pluginName: target.pluginName,
			});
			return extractPluginReadSkills(result);
		}),
	);
	return dedupeSkills(skills.flat());
}

function buildSkillInstructions(
	workflowSkills: CodexWorkflowSkill[],
	workflowSkillErrors: CodexWorkflowSkillError[],
): string | undefined {
	if (workflowSkills.length === 0 && workflowSkillErrors.length === 0) {
		return undefined;
	}

	const lines = [
		'## Skills',
		'These skills are available from Athena workflow plugins in this session.',
		'Only the skills explicitly listed below are available through Athena workflow plugins.',
		'Do not claim that any other skills, bundled skills, Claude skills, or utility skills are available unless they are listed here.',
	];

	for (const skill of workflowSkills) {
		const location = skill.path ? ` (file: ${skill.path})` : '';
		lines.push(`- ${skill.name}: ${skill.description ?? ''}${location}`);
		if (skill.dependencySummary.length > 0) {
			lines.push(`  Dependencies: ${skill.dependencySummary.join(', ')}`);
		}
	}

	lines.push(
		'If a task matches a skill description, invoke it with `$<skill-name>` and include the matching skill input item.',
	);

	if (workflowSkillErrors.length > 0) {
		lines.push('');
		lines.push('Unavailable workflow skills:');
		for (const error of workflowSkillErrors) {
			const location = error.path ? ` (file: ${error.path})` : '';
			lines.push(`- ${error.message}${location}`);
		}
	}
	return lines.join('\n');
}

export async function resolveCodexSkillInstructions(input: {
	manager: AppServerManager;
	projectDir: string;
	skillRoots?: string[];
	pluginTargets?: WorkflowPluginTarget[];
}): Promise<CodexSkillInstructionsResult> {
	const skillRoots = input.skillRoots?.filter(Boolean) ?? [];
	const pluginTargets = input.pluginTargets ?? [];
	if (skillRoots.length === 0 && pluginTargets.length === 0) {
		return {instructions: undefined, skills: [], errors: []};
	}

	const pluginSkills =
		pluginTargets.length > 0
			? await readPluginWorkflowSkills({
					manager: input.manager,
					pluginTargets,
				})
			: [];

	const scanResult =
		skillRoots.length > 0
			? await input.manager.sendRequest(M.SKILLS_LIST, {
					cwds: [input.projectDir],
					forceReload: true,
					perCwdExtraUserRoots: [
						{
							cwd: input.projectDir,
							extraUserRoots: skillRoots,
						},
					],
				})
			: undefined;

	const scannedSkills = scanResult
		? extractWorkflowSkills(scanResult, skillRoots)
		: [];
	const errors = scanResult ? extractWorkflowSkillErrors(scanResult) : [];
	const skills = dedupeSkills([...pluginSkills, ...scannedSkills]);
	return {
		instructions: buildSkillInstructions(skills, dedupeErrors(errors)),
		skills,
		errors: dedupeErrors(errors),
	};
}
