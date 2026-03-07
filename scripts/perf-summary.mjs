#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HELP = `Usage:
  node scripts/perf-summary.mjs <perf-log.ndjson> [--limit=<n>]

Examples:
  node scripts/perf-summary.mjs .profiles/tui-perf-2026-03-06.ndjson
  node scripts/perf-summary.mjs .profiles/latest.ndjson --limit=15
`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
	process.stdout.write(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = limitArg
	? Number.parseInt(limitArg.slice('--limit='.length), 10)
	: 10;
const logArg = args.find(arg => !arg.startsWith('--'));

if (!logArg) {
	fail('Missing perf log path.');
}

if (!Number.isFinite(limit) || limit <= 0) {
	fail(`Invalid --limit value: ${limitArg}`);
}

const logPath = path.resolve(logArg);
if (!fs.existsSync(logPath)) {
	fail(`Perf log not found: ${logPath}`);
}

const events = loadEvents(logPath);
const cycles = loadCycleSummaries(events);
if (cycles.length > 0) {
	renderCycleSummary(logPath, cycles, limit);
	process.exit(0);
}

const legacy = loadLegacySummary(events);
if (legacy) {
	renderLegacySummary(logPath, legacy, limit);
	process.exit(0);
}

fail(`No supported perf events found in ${logPath}`);

function loadEvents(filePath) {
	const raw = fs.readFileSync(filePath, 'utf8');
	const parsed = [];

	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			parsed.push(JSON.parse(line));
		} catch {
			// Ignore malformed lines so a partially-written file still summarizes.
		}
	}

	return parsed;
}

function loadCycleSummaries(events) {
	const summaries = new Map();

	for (const event of events) {
		if (event.type !== 'cycle.summary' || !event.cycle_id) continue;
		summaries.set(event.cycle_id, {
			cycle_id: String(event.cycle_id),
			cause: String(event.cause ?? 'unknown'),
			total_ms: numberField(event.total_ms),
			state_derive_ms: numberField(event.state_derive_ms),
			row_format_ms: numberField(event.row_format_ms),
			react_commit_ms: numberField(event.react_commit_ms),
			ink_diff_ms: numberField(event.ink_diff_ms),
			stdout_write_ms: numberField(event.stdout_write_ms),
			compute_ms: numberField(event.compute_ms),
			paint_ms: numberField(event.paint_ms),
			bytes_written: numberField(event.bytes_written),
			visible_rows_changed: numberField(event.visible_rows_changed),
			commits: numberField(event.commits),
			missed_budget_16_7: Boolean(event.missed_budget_16_7),
			missed_budget_33_3: Boolean(event.missed_budget_33_3),
		});
	}

	return [...summaries.values()];
}

function renderCycleSummary(logPath, cycles, limit) {
	const missCounts = summarizeMissTypes(cycles);
	const worstTotal = [...cycles]
		.sort((a, b) => b.total_ms - a.total_ms)
		.slice(0, limit);
	const worstPaint = [...cycles]
		.sort((a, b) => b.paint_ms - a.paint_ms)
		.slice(0, limit);
	const worstCompute = [...cycles]
		.sort((a, b) => b.compute_ms - a.compute_ms)
		.slice(0, limit);

	process.stdout.write(`Perf log: ${logPath}\n`);
	process.stdout.write(
		`Cycles: ${cycles.length}  Miss16.7: ${missCounts.miss16}  Miss33.3: ${missCounts.miss33}\n\n`,
	);

	process.stdout.write('Most Frequent Budget Misses\n');
	for (const {label, count} of missCounts.rows) {
		process.stdout.write(
			`  ${label.padEnd(18)} ${String(count).padStart(5)}\n`,
		);
	}

	process.stdout.write('\nWorst Total Cycles\n');
	renderCycleTable(worstTotal);

	process.stdout.write('\nWorst Paint Cycles\n');
	renderCycleTable(worstPaint);

	process.stdout.write('\nWorst Compute Cycles\n');
	renderCycleTable(worstCompute);
}

function summarizeMissTypes(cycles) {
	const counts = {
		miss33: 0,
		miss16only: 0,
		withinBudget: 0,
		miss16: 0,
	};

	for (const cycle of cycles) {
		if (cycle.missed_budget_16_7) counts.miss16 += 1;
		if (cycle.missed_budget_33_3) {
			counts.miss33 += 1;
			continue;
		}
		if (cycle.missed_budget_16_7) {
			counts.miss16only += 1;
			continue;
		}
		counts.withinBudget += 1;
	}

	return {
		...counts,
		rows: [
			{label: 'missed 33.3ms', count: counts.miss33},
			{label: 'missed 16.7ms', count: counts.miss16only},
			{label: 'within budget', count: counts.withinBudget},
		].sort((a, b) => b.count - a.count),
	};
}

function loadLegacySummary(events) {
	const commits = [];
	const slowOps = [];
	const inputHandlers = [];
	const eventLoopSamples = [];

	for (const event of events) {
		switch (event.type) {
			case 'react.commit':
				commits.push({
					id: String(event.id ?? 'unknown'),
					phase: String(event.phase ?? 'unknown'),
					actual_ms: numberField(event.actual_ms),
					base_ms: numberField(event.base_ms),
				});
				break;
			case 'slow.op':
				slowOps.push({
					name: String(event.name ?? 'unknown'),
					duration_ms: numberField(event.duration_ms),
					threshold_ms: numberField(event.threshold_ms),
				});
				break;
			case 'input.handler':
				inputHandlers.push({
					scope: String(event.scope ?? 'unknown'),
					key: String(event.key ?? 'unknown'),
					duration_ms: numberField(event.duration_ms),
					slow: Boolean(event.slow),
				});
				break;
			case 'event_loop.sample':
				eventLoopSamples.push({
					scope: String(event.scope ?? 'app'),
					max_ms: numberField(event.max_ms),
					p99_ms: numberField(event.p99_ms),
					p95_ms: numberField(event.p95_ms),
					mean_ms: numberField(event.mean_ms),
				});
				break;
			default:
				break;
		}
	}

	if (
		commits.length === 0 &&
		slowOps.length === 0 &&
		inputHandlers.length === 0 &&
		eventLoopSamples.length === 0
	) {
		return null;
	}

	return {
		commits,
		slowOps,
		inputHandlers,
		eventLoopSamples,
	};
}

function renderLegacySummary(logPath, legacy, limit) {
	process.stdout.write(`Perf log: ${logPath}\n`);
	process.stdout.write(
		'Legacy profile detected: this file predates cycle.summary and output/write tracing.\n\n',
	);

	if (legacy.commits.length > 0) {
		process.stdout.write('Worst React Commits\n');
		renderLegacyTable(
			[...legacy.commits]
				.sort((a, b) => b.actual_ms - a.actual_ms)
				.slice(0, limit),
			[
				['id', 28],
				['phase', 8],
				['actual', 10],
				['base', 10],
			],
			row => ({
				id: shorten(row.id, 28),
				phase: row.phase,
				actual: formatMs(row.actual_ms),
				base: formatMs(row.base_ms),
			}),
		);
		process.stdout.write('\n');
	}

	if (legacy.inputHandlers.length > 0) {
		process.stdout.write('Worst Input Handlers\n');
		renderLegacyTable(
			[...legacy.inputHandlers]
				.sort((a, b) => b.duration_ms - a.duration_ms)
				.slice(0, limit),
			[
				['scope', 20],
				['key', 16],
				['duration', 10],
				['slow', 6],
			],
			row => ({
				scope: shorten(row.scope, 20),
				key: shorten(row.key, 16),
				duration: formatMs(row.duration_ms),
				slow: row.slow ? 'yes' : 'no',
			}),
		);
		process.stdout.write('\n');
	}

	if (legacy.slowOps.length > 0) {
		process.stdout.write('Worst Slow Ops\n');
		renderLegacyTable(
			[...legacy.slowOps]
				.sort((a, b) => b.duration_ms - a.duration_ms)
				.slice(0, limit),
			[
				['name', 32],
				['duration', 10],
				['threshold', 10],
			],
			row => ({
				name: shorten(row.name, 32),
				duration: formatMs(row.duration_ms),
				threshold: formatMs(row.threshold_ms),
			}),
		);
		process.stdout.write('\n');
	}

	if (legacy.eventLoopSamples.length > 0) {
		process.stdout.write('Worst Event Loop Samples\n');
		renderLegacyTable(
			[...legacy.eventLoopSamples]
				.sort((a, b) => b.max_ms - a.max_ms)
				.slice(0, limit),
			[
				['scope', 10],
				['max', 10],
				['p99', 10],
				['p95', 10],
				['mean', 10],
			],
			row => ({
				scope: row.scope,
				max: formatMs(row.max_ms),
				p99: formatMs(row.p99_ms),
				p95: formatMs(row.p95_ms),
				mean: formatMs(row.mean_ms),
			}),
		);
	}
}

function renderCycleTable(cycles) {
	const rows = cycles.map(cycle => ({
		cause: shorten(cycle.cause, 24),
		total: formatMs(cycle.total_ms),
		compute: formatMs(cycle.compute_ms),
		paint: formatMs(cycle.paint_ms),
		state: formatMs(cycle.state_derive_ms),
		rows: formatMs(cycle.row_format_ms),
		react: formatMs(cycle.react_commit_ms),
		ink: formatMs(cycle.ink_diff_ms),
		write: formatMs(cycle.stdout_write_ms),
		bytes: formatInt(cycle.bytes_written),
		changed: formatInt(cycle.visible_rows_changed),
		commits: formatInt(cycle.commits),
		budget: cycle.missed_budget_33_3
			? '33.3'
			: cycle.missed_budget_16_7
				? '16.7'
				: '-',
	}));
	const widths = {
		cause: Math.max('cause'.length, ...rows.map(row => row.cause.length)),
		total: 8,
		compute: 8,
		paint: 8,
		state: 8,
		rows: 8,
		react: 8,
		ink: 8,
		write: 8,
		bytes: 9,
		changed: 8,
		commits: 7,
		budget: 6,
	};

	const header = [
		pad('cause', widths.cause),
		pad('total', widths.total),
		pad('compute', widths.compute),
		pad('paint', widths.paint),
		pad('state', widths.state),
		pad('rows', widths.rows),
		pad('react', widths.react),
		pad('ink', widths.ink),
		pad('write', widths.write),
		pad('bytes', widths.bytes),
		pad('changed', widths.changed),
		pad('commits', widths.commits),
		pad('miss', widths.budget),
	].join('  ');

	process.stdout.write(`${header}\n`);
	process.stdout.write(`${'-'.repeat(header.length)}\n`);

	for (const row of rows) {
		process.stdout.write(
			[
				pad(row.cause, widths.cause),
				pad(row.total, widths.total),
				pad(row.compute, widths.compute),
				pad(row.paint, widths.paint),
				pad(row.state, widths.state),
				pad(row.rows, widths.rows),
				pad(row.react, widths.react),
				pad(row.ink, widths.ink),
				pad(row.write, widths.write),
				pad(row.bytes, widths.bytes),
				pad(row.changed, widths.changed),
				pad(row.commits, widths.commits),
				pad(row.budget, widths.budget),
			].join('  ') + '\n',
		);
	}
}

function renderLegacyTable(rows, columns, formatRow) {
	const header = columns.map(([label, width]) => pad(label, width)).join('  ');
	process.stdout.write(`${header}\n`);
	process.stdout.write(`${'-'.repeat(header.length)}\n`);

	for (const row of rows) {
		const formatted = formatRow(row);
		process.stdout.write(
			columns.map(([label, width]) => pad(formatted[label], width)).join('  ') +
				'\n',
		);
	}
}

function numberField(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatMs(value) {
	return `${value.toFixed(2)}ms`;
}

function formatInt(value) {
	return String(Math.round(value));
}

function shorten(value, maxLength) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function pad(value, width) {
	return String(value).padEnd(width);
}

function fail(message) {
	process.stderr.write(`[perf-summary] ${message}\n`);
	process.stderr.write(HELP);
	process.exit(1);
}
