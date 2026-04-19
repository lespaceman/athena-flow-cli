/**
 * Shared definition of a permission suggestion payload attached to
 * Claude Code PermissionRequest events.
 *
 * Lives in `shared/` because both the `harnesses/claude` protocol types and
 * the layer-neutral `core/runtime` + `core/feed` types need the same shape,
 * and `core` may not import from `harnesses`.
 *
 * See: docs/claude_code/hooks.md (`permission_suggestions`).
 */

export type PermissionSuggestionDestination =
	| 'session'
	| 'localSettings'
	| 'projectSettings'
	| 'userSettings';

export type PermissionSuggestion = {
	type:
		| 'addRules'
		| 'replaceRules'
		| 'removeRules'
		| 'setMode'
		| 'addDirectories'
		| 'removeDirectories';
	destination: PermissionSuggestionDestination;
	rules?: Array<Record<string, unknown>>;
	behavior?: 'allow' | 'deny' | 'ask';
	mode?: string;
	directories?: string[];
};
