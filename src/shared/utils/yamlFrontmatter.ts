/**
 * Minimal YAML frontmatter parser for .md files.
 *
 * Handles the YAML subset used in skill and agent frontmatter:
 * - Plain `key: value` strings
 * - Folded scalars (`key: >` with indented continuation lines)
 * - Booleans (`true` / `false`)
 * - String arrays (lines starting with `  - `)
 *
 * Shared between SKILL.md and agent .md parsing.
 */

export type YamlValue = string | boolean | string[];

/**
 * Parse the simple YAML subset used in frontmatter blocks.
 */
export function parseSimpleYaml(lines: string[]): Record<string, YamlValue> {
	const result: Record<string, YamlValue> = {};
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		if (line.trim() === '') {
			i++;
			continue;
		}

		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) {
			i++;
			continue;
		}

		const key = line.slice(0, colonIdx).trim();
		const rawValue = line.slice(colonIdx + 1).trim();

		if (rawValue === '>') {
			// Folded scalar: collect indented continuation lines
			const parts: string[] = [];
			i++;
			while (i < lines.length && lines[i]!.startsWith('  ')) {
				parts.push(lines[i]!.trim());
				i++;
			}
			result[key] = parts.join(' ');
			continue;
		}

		if (rawValue === '') {
			// Could be a string array — check if next lines are `  - item`
			const items: string[] = [];
			i++;
			while (i < lines.length && /^\s+-\s/.test(lines[i]!)) {
				items.push(lines[i]!.replace(/^\s+-\s/, '').trim());
				i++;
			}
			if (items.length > 0) {
				result[key] = items;
			} else {
				result[key] = '';
			}
			continue;
		}

		if (rawValue === 'true') {
			result[key] = true;
			i++;
			continue;
		}
		if (rawValue === 'false') {
			result[key] = false;
			i++;
			continue;
		}

		result[key] = rawValue;
		i++;
	}

	return result;
}

/**
 * Split a markdown file into frontmatter YAML lines and body text.
 * Throws if the file does not start with a `---` frontmatter block.
 */
export function splitFrontmatter(
	content: string,
	label: string,
): {yamlLines: string[]; body: string} {
	const lines = content.split('\n');

	if (lines[0]?.trim() !== '---') {
		throw new Error(`${label} must start with --- frontmatter delimiter`);
	}

	const closingIndex = lines.indexOf('---', 1);
	if (closingIndex === -1) {
		throw new Error(`${label} missing closing --- frontmatter delimiter`);
	}

	return {
		yamlLines: lines.slice(1, closingIndex),
		body: lines
			.slice(closingIndex + 1)
			.join('\n')
			.trim(),
	};
}
