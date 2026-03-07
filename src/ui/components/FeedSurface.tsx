/**
 * FeedSurface — switchable rendering backend for the feed viewport.
 *
 * Accepts a structured FeedSurface model and renders it through one of two
 * backends:
 *   - `ink-full`      – joins all lines and renders via a single <Text> node
 *                        (current parity path, default)
 *   - `incremental`   – writes only changed lines directly to stdout via
 *                        ANSI escape sequences, bypassing Ink's full-frame diff
 *
 * The backend is selected via the `ATHENA_FEED_BACKEND` env var, defaulting
 * to `ink-full` when the var is missing or unrecognised.
 */
import React from 'react';
import {Text} from 'ink';
import {type FeedSurface as FeedSurfaceModel} from './feedSurfaceModel';
import {
	logFeedSurfaceRender,
	type FeedSurfaceBackend,
} from '../../shared/utils/perf';
import {IncrementalFeedSurface} from './IncrementalFeedSurface';

// ── Backend resolution ─────────────────────────────────────────────

const VALID_BACKENDS: ReadonlySet<string> = new Set<string>([
	'ink-full',
	'incremental',
]);

const DEFAULT_BACKEND: FeedSurfaceBackend = 'ink-full';

/**
 * Resolve the active backend from an explicit prop or the env var.
 * Falls back to `ink-full` for any unrecognised or missing value.
 */
export function resolveFeedBackend(explicit?: string): FeedSurfaceBackend {
	const raw = explicit ?? process.env['ATHENA_FEED_BACKEND'];
	if (raw && VALID_BACKENDS.has(raw)) {
		return raw as FeedSurfaceBackend;
	}
	return DEFAULT_BACKEND;
}

// ── Component ──────────────────────────────────────────────────────

type Props = {
	surface: FeedSurfaceModel;
	/** Override the env-var backend for testing / prop-drilling. */
	backend?: FeedSurfaceBackend;
	/**
	 * 1-based terminal row where the feed rectangle starts.
	 * Required when backend is 'incremental'.
	 */
	feedStartRow?: number;
	/**
	 * Writable stream for the incremental painter. Defaults to process.stdout.
	 */
	stdout?: {write(data: string): boolean};
};

/**
 * Renders a FeedSurface model through the selected backend.
 *
 * - `ink-full`: renders all lines via Ink's <Text> (baseline path).
 * - `incremental`: paints only changed lines directly to stdout.
 */
function FeedSurfaceImpl({
	surface,
	backend: backendProp,
	feedStartRow,
	stdout,
}: Props) {
	const backend = resolveFeedBackend(backendProp);

	// ── Incremental backend: bypass Ink entirely ───────────────────
	if (backend === 'incremental') {
		return (
			<IncrementalFeedSurface
				surface={surface}
				feedStartRow={feedStartRow ?? 1}
				stdout={stdout}
			/>
		);
	}

	// ── ink-full backend: render through Ink's <Text> ─────────────
	return <InkFullFeedSurface surface={surface} backend={backend} />;
}

/**
 * The ink-full rendering path — joins all lines and renders via a single
 * <Text> node. This is the baseline / parity path.
 */
function InkFullFeedSurface({
	surface,
	backend,
}: {
	surface: FeedSurfaceModel;
	backend: FeedSurfaceBackend;
}) {
	const output = React.useMemo(() => surface.allLines.join('\n'), [surface]);

	// Track previous line count so we can report changed/cleared lines.
	const prevLinesRef = React.useRef<number>(0);

	React.useEffect(() => {
		const linesRendered = surface.allLines.length;
		const prevLines = prevLinesRef.current;
		prevLinesRef.current = linesRendered;

		const linesCleared = Math.max(0, prevLines - linesRendered);
		// On first render everything is "changed"; subsequent renders
		// conservatively report all lines as changed for the ink-full path
		// (the incremental backend will compute real diffs).
		const linesChanged = linesRendered;

		logFeedSurfaceRender({
			backend,
			linesVisible: surface.visibleContentRows,
			linesRendered,
			linesChanged,
			linesCleared,
		});
	}, [surface, backend]);

	return <Text>{output}</Text>;
}

export const FeedSurfaceView = React.memo(FeedSurfaceImpl);
