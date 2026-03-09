import os from 'node:os';
import {capture} from './client';

function systemProps() {
	return {
		os: `${os.platform()}-${os.arch()}`,
		nodeVersion: process.version,
	};
}

export function trackAppLaunched(props: {
	version: string;
	harness: string;
}): void {
	capture('app.launched', {...props, ...systemProps()});
}

export function trackSessionStarted(props: {
	harness: string;
	workflow?: string;
	model?: string;
}): void {
	capture('session.started', props);
}

export function trackSessionEnded(props: {
	durationMs: number;
	toolCallCount: number;
	subagentCount: number;
	permissionsAllowed: number;
	permissionsDenied: number;
}): void {
	capture('session.ended', props);
}

function sanitizeStackTrace(stack: string): string {
	const home = os.homedir();
	return stack.replaceAll(home, '~');
}

export function trackError(props: {
	errorName: string;
	stackTrace: string;
}): void {
	capture('app.error', {
		errorName: props.errorName,
		stackTrace: sanitizeStackTrace(props.stackTrace),
	});
}

export function trackTelemetryOptedOut(): void {
	capture('telemetry.opted_out', {});
}

export type ClaudeStartupFailureStage =
	| 'spawn_error'
	| 'exit_nonzero'
	| 'startup_timeout';

function classifyClaudeStartupFailure(reason: string): string {
	const normalized = reason.toLowerCase();
	if (
		normalized.includes('enoent') ||
		normalized.includes('not found') ||
		normalized.includes('command not found')
	) {
		return 'binary_not_found';
	}
	if (
		normalized.includes('eacces') ||
		normalized.includes('permission denied')
	) {
		return 'permission_denied';
	}
	if (
		normalized.includes('timed out') ||
		normalized.includes('timeout') ||
		normalized.includes('etimedout')
	) {
		return 'timeout';
	}
	if (normalized.includes('auth') || normalized.includes('login')) {
		return 'auth_required';
	}
	if (
		normalized.includes('connection refused') ||
		normalized.includes('econnrefused')
	) {
		return 'connection_refused';
	}
	return 'other';
}

export function trackClaudeStartupFailed(props: {
	harness: string;
	failureStage: ClaudeStartupFailureStage;
	message: string;
	exitCode?: number;
}): void {
	const classifiedReason = classifyClaudeStartupFailure(props.message);
	const resolvedBinary =
		props.failureStage === 'exit_nonzero' ||
		props.failureStage === 'startup_timeout' ||
		classifiedReason !== 'binary_not_found';

	capture('claude.startup_failed', {
		harness: props.harness,
		platform: `${os.platform()}-${os.arch()}`,
		failure_stage: props.failureStage,
		resolved_binary: resolvedBinary,
		exit_code: props.exitCode,
		classified_reason: classifiedReason,
	});
}
