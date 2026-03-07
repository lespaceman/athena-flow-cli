#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';

const HELP = `Usage:
  node scripts/perf-runner.mjs [options] [-- <athena args>]

Options:
  --mode=<full|cpu|trace|heap>   Profiling mode (default: full)
  --out-dir=<dir>                Output directory (default: .profiles)
  --no-build                     Skip npm run build
  --no-app-profile               Disable ATHENA_PROFILE app instrumentation
  --help                         Show help

Examples:
  npm run perf:tui -- -- sessions
  npm run perf:cpu -- -- resume
`;

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
const athenaArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

let mode = 'full';
let outDir = '.profiles';
let shouldBuild = true;
let enableAppProfile = true;

for (const arg of optionArgs) {
	if (arg === '--help' || arg === '-h') {
		process.stdout.write(HELP);
		process.exit(0);
	}
	if (arg === '--no-build') {
		shouldBuild = false;
		continue;
	}
	if (arg === '--no-app-profile') {
		enableAppProfile = false;
		continue;
	}
	if (arg.startsWith('--mode=')) {
		mode = arg.slice('--mode='.length);
		continue;
	}
	if (arg.startsWith('--out-dir=')) {
		outDir = arg.slice('--out-dir='.length);
		continue;
	}
	fail(`Unknown option: ${arg}`);
}

const normalizedMode = mode.toLowerCase();
const validModes = new Set(['full', 'cpu', 'trace', 'heap']);
if (!validModes.has(normalizedMode)) {
	fail(`Invalid mode: ${mode}`);
}

const enableCpu = normalizedMode === 'full' || normalizedMode === 'cpu';
const enableTrace = normalizedMode === 'full' || normalizedMode === 'trace';
const enableHeap = normalizedMode === 'heap';

const absOutDir = path.resolve(outDir);
fs.mkdirSync(absOutDir, {recursive: true});

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const runTag = `${timestamp}-${process.pid}`;
const cpuProfileName = `athena-${runTag}.cpuprofile`;
const heapProfileName = `athena-${runTag}.heapprofile`;
const tracePattern = path.join(absOutDir, `node-trace-${runTag}-%pid.json`);
const appLogPath = path.join(absOutDir, `tui-perf-${runTag}.ndjson`);

if (shouldBuild) {
	runOrExit('npm', ['run', 'build']);
}

const nodeArgs = ['--enable-source-maps'];
if (enableCpu) {
	nodeArgs.push(
		'--cpu-prof',
		`--cpu-prof-dir=${absOutDir}`,
		`--cpu-prof-name=${cpuProfileName}`,
	);
}
if (enableHeap) {
	nodeArgs.push(
		'--heap-prof',
		`--heap-prof-dir=${absOutDir}`,
		`--heap-prof-name=${heapProfileName}`,
	);
}
if (enableTrace) {
	nodeArgs.push(
		'--trace-events-enabled',
		'--trace-event-categories=v8,node,node.async_hooks',
		`--trace-event-file-pattern=${tracePattern}`,
	);
}

nodeArgs.push(path.resolve('dist/cli.js'));
nodeArgs.push(...athenaArgs);

const runEnv = {...process.env};
if (enableAppProfile) {
	runEnv['ATHENA_PROFILE'] = '1';
	if (!runEnv['ATHENA_PROFILE_LOG']) {
		runEnv['ATHENA_PROFILE_LOG'] = appLogPath;
	}
	if (!runEnv['ATHENA_PROFILE_LOOP_MS']) {
		runEnv['ATHENA_PROFILE_LOOP_MS'] = '150';
	}
}

process.stderr.write(
	`[perf] mode=${normalizedMode} out=${absOutDir} app_profile=${enableAppProfile ? 'on' : 'off'}\n`,
);
if (enableCpu) {
	process.stderr.write(
		`[perf] CPU profile: ${path.join(absOutDir, cpuProfileName)}\n`,
	);
}
if (enableHeap) {
	process.stderr.write(
		`[perf] Heap profile: ${path.join(absOutDir, heapProfileName)}\n`,
	);
}
if (enableTrace) {
	process.stderr.write(
		`[perf] Trace events: ${path.join(absOutDir, `node-trace-${runTag}-<pid>.json`)}\n`,
	);
}
if (enableAppProfile) {
	process.stderr.write(
		`[perf] App perf log: ${runEnv['ATHENA_PROFILE_LOG']}\n`,
	);
}

const cliRun = spawnSync(process.execPath, nodeArgs, {
	stdio: 'inherit',
	env: runEnv,
});

if (cliRun.error) {
	fail(`Failed to start profiled CLI: ${cliRun.error.message}`);
}

process.exit(cliRun.status ?? 1);

function runOrExit(command, commandArgs) {
	const result = spawnSync(command, commandArgs, {
		stdio: 'inherit',
		env: process.env,
	});
	if (result.error) {
		fail(
			`Failed to run "${command} ${commandArgs.join(' ')}": ${result.error.message}`,
		);
	}
	if ((result.status ?? 1) !== 0) {
		process.exit(result.status ?? 1);
	}
}

function fail(message) {
	process.stderr.write(`[perf] ${message}\n`);
	process.stderr.write(HELP);
	process.exit(1);
}
