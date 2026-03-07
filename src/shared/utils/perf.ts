import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';

type PerfScalar = string | number | boolean | null;
type PerfFields = Record<string, PerfScalar | undefined>;
type StopMeasure = () => void;
type PerfStageName =
	| 'cause.start'
	| 'state.derive'
	| 'timeline.build'
	| 'filter.search'
	| 'feed.columns'
	| 'feed.rows.format'
	| 'react.commit'
	| 'ink.diff'
	| 'stdout.write';
type PerfCycleReason = 'idle' | 'superseded' | 'process_exit';
type PerfInterval = {
	startedAt: number;
	endedAt: number;
};

type InkKeyLike = {
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
	return?: boolean;
	escape?: boolean;
	tab?: boolean;
	home?: boolean;
	end?: boolean;
	pageUp?: boolean;
	pageDown?: boolean;
	delete?: boolean;
	backspace?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
};

const PERF_ENABLED = process.env['ATHENA_PROFILE'] === '1';
const LOG_ALL_INPUT = process.env['ATHENA_PROFILE_INPUT_ALL'] === '1';
const DEFAULT_SLOW_MS = readNumberEnv('ATHENA_PROFILE_SLOW_MS', 8);
const INPUT_SLOW_MS = readNumberEnv('ATHENA_PROFILE_INPUT_SLOW_MS', 4);
const CYCLE_IDLE_MS = Math.max(
	16,
	Math.floor(readNumberEnv('ATHENA_PROFILE_CYCLE_IDLE_MS', 40)),
);
const INPUT_CAUSE_DEDUPE_MS = Math.max(
	1,
	Math.floor(readNumberEnv('ATHENA_PROFILE_INPUT_DEDUPE_MS', 2)),
);
const LOOP_INTERVAL_MS = Math.max(
	200,
	Math.floor(readNumberEnv('ATHENA_PROFILE_LOOP_MS', 1000)),
);

const NOOP: StopMeasure = () => {};
const EMPTY_FIELDS: PerfFields = {};
const COMPUTE_STAGE_NAMES: readonly PerfStageName[] = [
	'state.derive',
	'timeline.build',
	'filter.search',
	'feed.columns',
	'feed.rows.format',
];
const PAINT_STAGE_NAMES: readonly PerfStageName[] = [
	'react.commit',
	'ink.diff',
	'stdout.write',
];

let stream: fs.WriteStream | null = null;
let streamPath: string | null = null;
let streamInitFailed = false;
let startupWritten = false;
let cycleCounter = 0;
let activeCycleId: string | null = null;
let cycleIdleTimer: NodeJS.Timeout | null = null;
let stdoutMonitorInstalled = false;
let beforeExitRegistered = false;
let lastInputCause: {
	cause: string;
	startedAt: number;
	cycleId: string | null;
} | null = null;

export type FeedSurfaceBackend = 'ink-full' | 'incremental';

type PerfCycle = {
	id: string;
	cause: string;
	causes: string[];
	startedAt: number;
	lastActivityAt: number;
	lastMeasuredAt: number;
	pendingWrites: number;
	finalReason?: PerfCycleReason;
	fields: PerfFields;
	stageDurations: Record<PerfStageName, number>;
	stageIntervals: Record<PerfStageName, PerfInterval[]>;
	commits: number;
	rowsFormatted: number;
	visibleRows: number;
	visibleRowsChanged: number;
	visibleRowsTouched: number;
	viewportShift: number;
	focusMoved: boolean;
	bytesWritten: number;
	writes: number;
	writeDurationMs: number;
	feedSurfaceBackend?: FeedSurfaceBackend;
	feedLinesVisible: number;
	feedLinesRendered: number;
	feedLinesChanged: number;
	feedLinesCleared: number;
};

const openCycles = new Map<string, PerfCycle>();

function readNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMs(value: number): number {
	return Number(value.toFixed(3));
}

function nsToMs(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value / 1_000_000;
}

function defaultLogPath(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return path.join(process.cwd(), '.profiles', `athena-perf-${stamp}.ndjson`);
}

function ensureStream(): fs.WriteStream | null {
	if (!PERF_ENABLED || streamInitFailed) return null;
	if (stream) return stream;

	try {
		const configured = process.env['ATHENA_PROFILE_LOG'];
		const target = path.resolve(configured ?? defaultLogPath());
		fs.mkdirSync(path.dirname(target), {recursive: true});
		stream = fs.createWriteStream(target, {flags: 'a'});
		streamPath = target;
		stream.on('error', () => {
			streamInitFailed = true;
		});
	} catch {
		streamInitFailed = true;
		return null;
	}

	return stream;
}

function writeEvent(type: string, fields: PerfFields = {}): void {
	if (!PERF_ENABLED) return;
	const writer = ensureStream();
	if (!writer) return;
	ensureBeforeExitFlush();

	if (!startupWritten) {
		startupWritten = true;
		writeEvent('profile.start', {
			pid: process.pid,
			node: process.version,
			log_path: streamPath ?? undefined,
		});
	}

	const payload: Record<string, unknown> = {
		type,
		ts: Date.now(),
		iso: new Date().toISOString(),
	};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) payload[key] = value;
	}

	writer.write(`${JSON.stringify(payload)}\n`);
}

function createStageDurations(): Record<PerfStageName, number> {
	return {
		'cause.start': 0,
		'state.derive': 0,
		'timeline.build': 0,
		'filter.search': 0,
		'feed.columns': 0,
		'feed.rows.format': 0,
		'react.commit': 0,
		'ink.diff': 0,
		'stdout.write': 0,
	};
}

function createStageIntervals(): Record<PerfStageName, PerfInterval[]> {
	return {
		'cause.start': [],
		'state.derive': [],
		'timeline.build': [],
		'filter.search': [],
		'feed.columns': [],
		'feed.rows.format': [],
		'react.commit': [],
		'ink.diff': [],
		'stdout.write': [],
	};
}

function getCycle(cycleId: string | null | undefined): PerfCycle | null {
	if (!cycleId) return null;
	return openCycles.get(cycleId) ?? null;
}

function getActiveCycle(): PerfCycle | null {
	return getCycle(activeCycleId);
}

function mergeFields(target: PerfFields, next: PerfFields): void {
	for (const [key, value] of Object.entries(next)) {
		if (value !== undefined) target[key] = value;
	}
}

function attachCycleFields(
	fields: PerfFields,
	cycle: PerfCycle | null,
): PerfFields {
	if (!cycle) return fields;
	return {
		...fields,
		cycle_id: cycle.id,
		cycle_cause: cycle.cause,
	};
}

function mergedIntervalDuration(intervals: PerfInterval[]): number {
	if (intervals.length === 0) return 0;
	const sorted = [...intervals].sort((a, b) => a.startedAt - b.startedAt);
	let total = 0;
	let currentStart = sorted[0]!.startedAt;
	let currentEnd = sorted[0]!.endedAt;

	for (let i = 1; i < sorted.length; i++) {
		const interval = sorted[i]!;
		if (interval.startedAt <= currentEnd) {
			currentEnd = Math.max(currentEnd, interval.endedAt);
			continue;
		}
		total += currentEnd - currentStart;
		currentStart = interval.startedAt;
		currentEnd = interval.endedAt;
	}

	return total + (currentEnd - currentStart);
}

function stageGroupDuration(
	stageIntervals: Record<PerfStageName, PerfInterval[]>,
	names: readonly PerfStageName[],
): number {
	const merged: PerfInterval[] = [];
	for (const name of names) {
		merged.push(...stageIntervals[name]);
	}
	return mergedIntervalDuration(merged);
}

function emitCycleSummary(cycle: PerfCycle, reason: PerfCycleReason): void {
	const totalMs = Math.max(0, cycle.lastMeasuredAt - cycle.startedAt);
	const computeMs = stageGroupDuration(
		cycle.stageIntervals,
		COMPUTE_STAGE_NAMES,
	);
	const paintMs = stageGroupDuration(cycle.stageIntervals, PAINT_STAGE_NAMES);
	const stdoutWriteMs = mergedIntervalDuration(
		cycle.stageIntervals['stdout.write'],
	);

	writeEvent('cycle.summary', {
		cycle_id: cycle.id,
		cause: cycle.cause,
		cause_chain:
			cycle.causes.length > 1 ? cycle.causes.slice(1).join(' > ') : undefined,
		reason,
		total_ms: roundMs(totalMs),
		cause_start_ms: roundMs(cycle.stageDurations['cause.start']),
		state_derive_ms: roundMs(cycle.stageDurations['state.derive']),
		timeline_build_ms: roundMs(cycle.stageDurations['timeline.build']),
		filter_search_ms: roundMs(cycle.stageDurations['filter.search']),
		feed_columns_ms: roundMs(cycle.stageDurations['feed.columns']),
		row_format_ms: roundMs(cycle.stageDurations['feed.rows.format']),
		react_commit_ms: roundMs(cycle.stageDurations['react.commit']),
		ink_diff_ms: roundMs(cycle.stageDurations['ink.diff']),
		stdout_write_ms: roundMs(stdoutWriteMs),
		stdout_write_raw_ms: roundMs(cycle.stageDurations['stdout.write']),
		compute_ms: roundMs(computeMs),
		paint_ms: roundMs(paintMs),
		missed_budget_16_7: totalMs > 16.7,
		missed_budget_33_3: totalMs > 33.3,
		visible_rows: cycle.visibleRows,
		visible_rows_changed: cycle.visibleRowsChanged,
		visible_rows_touched: cycle.visibleRowsTouched,
		rows_formatted: cycle.rowsFormatted,
		viewport_shift: cycle.viewportShift,
		focus_moved: cycle.focusMoved,
		bytes_written: cycle.bytesWritten,
		writes: cycle.writes,
		commits: cycle.commits,
		feed_surface_backend: cycle.feedSurfaceBackend,
		feed_lines_visible: cycle.feedLinesVisible,
		feed_lines_rendered: cycle.feedLinesRendered,
		feed_lines_changed: cycle.feedLinesChanged,
		feed_lines_cleared: cycle.feedLinesCleared,
		...cycle.fields,
	});
}

function clearIdleTimer(): void {
	if (!cycleIdleTimer) return;
	clearTimeout(cycleIdleTimer);
	cycleIdleTimer = null;
}

function scheduleIdleFlush(): void {
	if (!PERF_ENABLED) return;
	const cycle = getActiveCycle();
	clearIdleTimer();
	if (!cycle) return;
	cycleIdleTimer = setTimeout(() => {
		const current = getCycle(cycle.id);
		if (!current || activeCycleId !== cycle.id) return;
		const idleForMs = performance.now() - current.lastActivityAt;
		if (idleForMs < CYCLE_IDLE_MS) {
			scheduleIdleFlush();
			return;
		}
		requestFinalizeCycle(current.id, 'idle');
	}, CYCLE_IDLE_MS);
	cycleIdleTimer.unref();
}

function tryFinalizeCycle(cycleId: string): void {
	const cycle = getCycle(cycleId);
	if (!cycle || !cycle.finalReason) return;
	if (cycle.pendingWrites > 0) return;
	if (activeCycleId === cycleId) return;
	openCycles.delete(cycleId);
	emitCycleSummary(cycle, cycle.finalReason);
}

function requestFinalizeCycle(cycleId: string, reason: PerfCycleReason): void {
	const cycle = getCycle(cycleId);
	if (!cycle) return;
	cycle.finalReason = reason;
	if (activeCycleId === cycleId) {
		activeCycleId = null;
		clearIdleTimer();
	}
	tryFinalizeCycle(cycleId);
}

function touchCycle(
	cycle: PerfCycle | null,
	fields: PerfFields = EMPTY_FIELDS,
): void {
	if (!cycle) return;
	cycle.lastActivityAt = performance.now();
	mergeFields(cycle.fields, fields);
	if (cycle.id === activeCycleId) {
		scheduleIdleFlush();
	}
}

function beginCycle(
	cause: string,
	fields: PerfFields = EMPTY_FIELDS,
): PerfCycle | null {
	if (!PERF_ENABLED) return null;

	const previousCycleId = activeCycleId;
	if (previousCycleId) {
		requestFinalizeCycle(previousCycleId, 'superseded');
	}

	const now = performance.now();
	const cycle: PerfCycle = {
		id: `cycle-${++cycleCounter}`,
		cause,
		causes: [cause],
		startedAt: now,
		lastActivityAt: now,
		pendingWrites: 0,
		fields: {...fields},
		stageDurations: createStageDurations(),
		stageIntervals: createStageIntervals(),
		commits: 0,
		rowsFormatted: 0,
		visibleRows: 0,
		visibleRowsChanged: 0,
		visibleRowsTouched: 0,
		viewportShift: 0,
		focusMoved: false,
		bytesWritten: 0,
		writes: 0,
		writeDurationMs: 0,
		feedSurfaceBackend: undefined,
		feedLinesVisible: 0,
		feedLinesRendered: 0,
		feedLinesChanged: 0,
		feedLinesCleared: 0,
		lastMeasuredAt: now,
	};

	openCycles.set(cycle.id, cycle);
	activeCycleId = cycle.id;
	writeEvent('cause.start', attachCycleFields({cause, ...fields}, cycle));
	scheduleIdleFlush();
	return cycle;
}

function ensureBeforeExitFlush(): void {
	if (beforeExitRegistered || !PERF_ENABLED) return;
	beforeExitRegistered = true;
	process.once('beforeExit', () => {
		clearIdleTimer();
		if (activeCycleId) {
			requestFinalizeCycle(activeCycleId, 'process_exit');
		}
		for (const cycleId of [...openCycles.keys()]) {
			const cycle = openCycles.get(cycleId);
			if (!cycle) continue;
			cycle.pendingWrites = 0;
			cycle.finalReason ??= 'process_exit';
			activeCycleId = activeCycleId === cycleId ? null : activeCycleId;
			tryFinalizeCycle(cycleId);
		}
	});
}

function recordStageDuration(
	stage: PerfStageName,
	startedAt: number,
	endedAt: number,
	fields: PerfFields = EMPTY_FIELDS,
	cycleId = activeCycleId,
): void {
	const cycle = getCycle(cycleId);
	if (!cycle) return;
	const durationMs = Math.max(0, endedAt - startedAt);
	cycle.stageDurations[stage] += durationMs;
	if (durationMs > 0) {
		cycle.stageIntervals[stage].push({startedAt, endedAt});
		cycle.lastMeasuredAt = Math.max(cycle.lastMeasuredAt, endedAt);
	}
	touchCycle(cycle, fields);
}

function recordStdoutWrite(
	cycleId: string | null,
	bytes: number,
	durationMs: number,
): void {
	const cycle = getCycle(cycleId);
	if (!cycle) return;
	cycle.bytesWritten += bytes;
	cycle.writes += 1;
	cycle.writeDurationMs += durationMs;
	const endedAt = performance.now();
	recordStageDuration(
		'stdout.write',
		endedAt - durationMs,
		endedAt,
		EMPTY_FIELDS,
		cycleId,
	);
	writeEvent(
		'output.write',
		attachCycleFields(
			{
				bytes,
				writes: 1,
				duration_ms: roundMs(durationMs),
			},
			cycle,
		),
	);
}

function renderInputChar(input: string): string {
	if (input === ' ') return 'Space';
	if (!input) return '';
	if (/^[\x20-\x7E]+$/.test(input)) return input;
	return [...input]
		.map(ch => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`)
		.join('+');
}

export function describeInkKey(input: string, key: InkKeyLike): string {
	if (key.ctrl && input) return `Ctrl+${renderInputChar(input)}`;
	if (key.meta && input) return `Meta+${renderInputChar(input)}`;
	if (key.shift && input) return `Shift+${renderInputChar(input)}`;
	if (key.upArrow) return 'ArrowUp';
	if (key.downArrow) return 'ArrowDown';
	if (key.leftArrow) return 'ArrowLeft';
	if (key.rightArrow) return 'ArrowRight';
	if (key.pageUp) return 'PageUp';
	if (key.pageDown) return 'PageDown';
	if (key.home) return 'Home';
	if (key.end) return 'End';
	if (key.escape) return 'Escape';
	if (key.tab) return 'Tab';
	if (key.return) return 'Enter';
	if (key.delete) return 'Delete';
	if (key.backspace) return 'Backspace';
	return renderInputChar(input) || 'Unknown';
}

export function isPerfEnabled(): boolean {
	return PERF_ENABLED;
}

export function getPerfLogPath(): string | null {
	if (!PERF_ENABLED) return null;
	ensureStream();
	return streamPath;
}

export function logPerfEvent(type: string, fields: PerfFields = {}): void {
	writeEvent(type, fields);
}

export function startPerfCycle(
	cause: string,
	fields: PerfFields = {},
): string | null {
	return beginCycle(cause, fields)?.id ?? null;
}

export function getActivePerfCycleId(): string | null {
	return activeCycleId;
}

export function linkPerfCycleCause(
	cause: string,
	fields: PerfFields = {},
): string | null {
	if (!PERF_ENABLED) return null;
	const cycle = getActiveCycle();
	if (!cycle) {
		return startPerfCycle(cause, fields);
	}
	if (!cycle.causes.includes(cause)) {
		cycle.causes.push(cause);
	}
	touchCycle(cycle, fields);
	writeEvent('cause.link', attachCycleFields({cause, ...fields}, cycle));
	return cycle.id;
}

export function startPerfStage(
	stage: PerfStageName,
	fields: PerfFields = {},
): StopMeasure {
	if (!PERF_ENABLED) return NOOP;
	const cycleId = activeCycleId;
	if (!cycleId) return NOOP;
	const startedAt = performance.now();
	return () => {
		const endedAt = performance.now();
		recordStageDuration(stage, startedAt, endedAt, fields, cycleId);
	};
}

export function startPerfMeasure(
	name: string,
	fields: PerfFields = {},
	thresholdMs = DEFAULT_SLOW_MS,
): StopMeasure {
	if (!PERF_ENABLED) return NOOP;
	const startedAt = performance.now();
	return () => {
		const durationMs = performance.now() - startedAt;
		if (durationMs < thresholdMs) return;
		writeEvent('slow.op', {
			name,
			duration_ms: roundMs(durationMs),
			threshold_ms: thresholdMs,
			...fields,
		});
	};
}

export function startInputMeasure(
	scope: string,
	input: string,
	key: InkKeyLike,
): StopMeasure {
	if (!PERF_ENABLED) return NOOP;
	const label = describeInkKey(input, key);
	const cause = `input:${label}`;
	const startedAt = performance.now();
	const now = startedAt;
	let cycleId = activeCycleId;
	if (
		!lastInputCause ||
		lastInputCause.cause !== cause ||
		now - lastInputCause.startedAt > INPUT_CAUSE_DEDUPE_MS ||
		lastInputCause.cycleId !== activeCycleId
	) {
		cycleId = startPerfCycle(cause, {
			input_scope: scope,
			key: label,
		});
		lastInputCause = {
			cause,
			startedAt: now,
			cycleId,
		};
	} else {
		cycleId = lastInputCause.cycleId;
	}
	return () => {
		const endedAt = performance.now();
		const durationMs = endedAt - startedAt;
		recordStageDuration(
			'cause.start',
			startedAt,
			endedAt,
			{
				source: 'input.handler',
				input_scope: scope,
				key: label,
			},
			cycleId,
		);
		if (!LOG_ALL_INPUT && durationMs < INPUT_SLOW_MS) return;
		writeEvent(
			'input.handler',
			attachCycleFields(
				{
					scope,
					key: label,
					duration_ms: roundMs(durationMs),
					slow: durationMs >= INPUT_SLOW_MS,
				},
				getCycle(cycleId),
			),
		);
	};
}

export function logReactCommit(
	id: string,
	phase: string,
	actualDuration: number,
	baseDuration: number,
	startTime: number,
	commitTime: number,
): void {
	if (!PERF_ENABLED) return;
	const cycle = getActiveCycle();
	if (cycle) {
		cycle.commits += 1;
		const endedAt = performance.now();
		recordStageDuration(
			'react.commit',
			Math.max(cycle.startedAt, endedAt - actualDuration),
			endedAt,
			EMPTY_FIELDS,
			cycle.id,
		);
	}
	writeEvent(
		'react.commit',
		attachCycleFields(
			{
				id,
				phase,
				actual_ms: roundMs(actualDuration),
				base_ms: roundMs(baseDuration),
				start_ms: roundMs(startTime),
				commit_ms: roundMs(commitTime),
			},
			cycle,
		),
	);
}

export function logInkRender(durationMs: number): void {
	if (!PERF_ENABLED) return;
	const cycle = getActiveCycle();
	if (cycle) {
		const endedAt = performance.now();
		recordStageDuration(
			'ink.diff',
			Math.max(cycle.startedAt, endedAt - durationMs),
			endedAt,
			EMPTY_FIELDS,
			cycle.id,
		);
	}
	writeEvent(
		'ink.diff',
		attachCycleFields(
			{
				duration_ms: roundMs(durationMs),
			},
			cycle,
		),
	);
}

export function logFeedViewportDiff({
	visibleRows,
	rowsChanged,
	viewportShift,
	focusMoved,
}: {
	visibleRows: number;
	rowsChanged: number;
	viewportShift: number;
	focusMoved: boolean;
}): void {
	if (!PERF_ENABLED) return;
	const cycle = getActiveCycle();
	if (!cycle) return;
	cycle.visibleRows = Math.max(cycle.visibleRows, visibleRows);
	cycle.visibleRowsChanged += rowsChanged;
	cycle.viewportShift += viewportShift;
	cycle.focusMoved = cycle.focusMoved || focusMoved;
	touchCycle(cycle);
	writeEvent(
		'feed.viewport.diff',
		attachCycleFields(
			{
				visible_rows: visibleRows,
				rows_changed: rowsChanged,
				viewport_shift: viewportShift,
				focus_moved: focusMoved,
			},
			cycle,
		),
	);
}

export function logFeedSurfaceRender({
	backend,
	linesVisible,
	linesRendered,
	linesChanged,
	linesCleared,
}: {
	backend: FeedSurfaceBackend;
	linesVisible: number;
	linesRendered: number;
	linesChanged: number;
	linesCleared: number;
}): void {
	if (!PERF_ENABLED) return;
	const cycle = getActiveCycle();
	if (!cycle) return;
	cycle.feedSurfaceBackend = backend;
	cycle.feedLinesVisible = Math.max(cycle.feedLinesVisible, linesVisible);
	cycle.feedLinesRendered += linesRendered;
	cycle.feedLinesChanged += linesChanged;
	cycle.feedLinesCleared += linesCleared;
	touchCycle(cycle);
	writeEvent(
		'feed.surface.render',
		attachCycleFields(
			{
				backend,
				lines_visible: linesVisible,
				lines_rendered: linesRendered,
				lines_changed: linesChanged,
				lines_cleared: linesCleared,
			},
			cycle,
		),
	);
}

export function logVisibleRowFormat(durationMs: number): void {
	if (!PERF_ENABLED) return;
	const cycle = getActiveCycle();
	if (!cycle) return;
	cycle.rowsFormatted += 1;
	cycle.visibleRowsTouched += 1;
	const endedAt = performance.now();
	recordStageDuration(
		'feed.rows.format',
		Math.max(cycle.startedAt, endedAt - durationMs),
		endedAt,
		EMPTY_FIELDS,
		cycle.id,
	);
}

export function installStdoutWriteMonitor(
	target: NodeJS.WriteStream = process.stdout,
): void {
	if (!PERF_ENABLED || stdoutMonitorInstalled) return;
	stdoutMonitorInstalled = true;
	const originalWrite = target.write.bind(target);

	target.write = ((chunk: unknown, ...rest: unknown[]) => {
		const cycleId = activeCycleId;
		const cycle = getCycle(cycleId);
		if (cycle) {
			cycle.pendingWrites += 1;
			touchCycle(cycle);
		}

		const encoding =
			typeof rest[0] === 'string'
				? rest[0]
				: typeof rest[1] === 'string'
					? rest[1]
					: undefined;
		const bytes =
			typeof chunk === 'string'
				? Buffer.byteLength(chunk, encoding as BufferEncoding | undefined)
				: Buffer.isBuffer(chunk)
					? chunk.byteLength
					: typeof (chunk as {byteLength?: unknown})?.byteLength === 'number'
						? Number((chunk as {byteLength: number}).byteLength)
						: Buffer.byteLength(String(chunk ?? ''));
		const startedAt = performance.now();
		const callbackIndex =
			typeof rest[1] === 'function'
				? 1
				: typeof rest[0] === 'function'
					? 0
					: -1;
		const userCallback =
			callbackIndex >= 0
				? (rest[callbackIndex] as (() => void) | undefined)
				: undefined;

		const wrappedCallback = () => {
			recordStdoutWrite(cycleId, bytes, performance.now() - startedAt);
			const resolvedCycle = getCycle(cycleId);
			if (resolvedCycle) {
				resolvedCycle.pendingWrites = Math.max(
					0,
					resolvedCycle.pendingWrites - 1,
				);
				if (resolvedCycle.finalReason && activeCycleId !== cycleId) {
					tryFinalizeCycle(cycleId!);
				}
			}
			userCallback?.();
		};

		if (callbackIndex >= 0) {
			rest[callbackIndex] = wrappedCallback;
		} else {
			rest.push(wrappedCallback);
		}

		try {
			return originalWrite(chunk as never, ...(rest as [never?, never?]));
		} catch (error) {
			const resolvedCycle = getCycle(cycleId);
			if (resolvedCycle) {
				resolvedCycle.pendingWrites = Math.max(
					0,
					resolvedCycle.pendingWrites - 1,
				);
				if (resolvedCycle.finalReason && activeCycleId !== cycleId) {
					tryFinalizeCycle(cycleId!);
				}
			}
			throw error;
		}
	}) as typeof target.write;
}

export function startEventLoopMonitor(scope = 'app'): StopMeasure {
	if (!PERF_ENABLED) return NOOP;

	const histogram = monitorEventLoopDelay({resolution: 20});
	histogram.enable();

	writeEvent('event_loop.start', {
		scope,
		interval_ms: LOOP_INTERVAL_MS,
		log_path: getPerfLogPath() ?? undefined,
	});

	const timer = setInterval(() => {
		writeEvent('event_loop.sample', {
			scope,
			min_ms: roundMs(nsToMs(histogram.min)),
			mean_ms: roundMs(nsToMs(histogram.mean)),
			p50_ms: roundMs(nsToMs(histogram.percentile(50))),
			p95_ms: roundMs(nsToMs(histogram.percentile(95))),
			p99_ms: roundMs(nsToMs(histogram.percentile(99))),
			max_ms: roundMs(nsToMs(histogram.max)),
		});
		histogram.reset();
	}, LOOP_INTERVAL_MS);
	timer.unref();

	return () => {
		clearInterval(timer);
		histogram.disable();
		writeEvent('event_loop.stop', {scope});
	};
}
