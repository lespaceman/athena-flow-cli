import type {FeedEventKind} from './types';

/**
 * Low-signal feed event kinds that use generic default rendering across
 * `timeline.ts` (eventOperation/eventLabel) and `renderDetailLines.ts`.
 *
 * Adding a new default-render kind requires only:
 *   1. Add to `FeedEventKind` union (in ./types).
 *   2. Add to the `DefaultRenderKind` union and `DEFAULT_RENDER` set below.
 *
 * None of the per-switch case arms in the consumers need updating.
 */
export type DefaultRenderKind =
	| 'compact.post'
	| 'task.created'
	| 'cwd.changed'
	| 'file.changed'
	| 'stop.failure'
	| 'permission.denied'
	| 'elicitation.request'
	| 'elicitation.result';

export const DEFAULT_RENDER: ReadonlySet<DefaultRenderKind> =
	new Set<DefaultRenderKind>([
		'compact.post',
		'task.created',
		'cwd.changed',
		'file.changed',
		'stop.failure',
		'permission.denied',
		'elicitation.request',
		'elicitation.result',
	]);

export function isDefaultRenderKind(k: FeedEventKind): k is DefaultRenderKind {
	return DEFAULT_RENDER.has(k as DefaultRenderKind);
}
