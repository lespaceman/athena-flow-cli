export type TemplateContext = {
	input?: string;
	sessionId?: string;
	trackerPath?: string;
};

/**
 * Substitute template variables in a text string.
 * Used by all three prompt pipelines: user prompt, continue prompt, system prompt.
 */
export function substituteVariables(
	text: string,
	ctx: TemplateContext,
): string {
	let result = text;
	if (ctx.input !== undefined) {
		result = result.replaceAll('{input}', ctx.input);
	}
	if (ctx.sessionId !== undefined) {
		result = result.replaceAll('{sessionId}', ctx.sessionId);
		result = result.replaceAll('<session_id>', ctx.sessionId);
	}
	if (ctx.trackerPath !== undefined) {
		result = result.replaceAll('{trackerPath}', ctx.trackerPath);
	}
	return result;
}
