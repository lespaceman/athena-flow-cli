import {describe, it, expect, vi, beforeEach} from 'vitest';
import * as client from '../client';
import {
	trackAppLaunched,
	trackClaudeStartupFailed,
	trackSessionEnded,
} from '../events';

vi.mock('../client', () => ({
	capture: vi.fn(),
	isTelemetryEnabled: vi.fn().mockReturnValue(true),
}));

describe('telemetry events', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('tracks app launched with correct properties', () => {
		trackAppLaunched({version: '1.0.0', harness: 'claude-code'});
		expect(client.capture).toHaveBeenCalledWith('app.launched', {
			version: '1.0.0',
			harness: 'claude-code',
			os: expect.any(String),
			nodeVersion: expect.any(String),
		});
	});

	it('tracks session ended with metrics', () => {
		trackSessionEnded({
			durationMs: 5000,
			toolCallCount: 10,
			subagentCount: 2,
			permissionsAllowed: 8,
			permissionsDenied: 1,
		});
		expect(client.capture).toHaveBeenCalledWith('session.ended', {
			durationMs: 5000,
			toolCallCount: 10,
			subagentCount: 2,
			permissionsAllowed: 8,
			permissionsDenied: 1,
		});
	});

	it('tracks sanitized Claude startup failure diagnostics', () => {
		trackClaudeStartupFailed({
			harness: 'claude-code',
			failureStage: 'spawn_error',
			message: 'spawn claude ENOENT',
		});
		expect(client.capture).toHaveBeenCalledWith('claude.startup_failed', {
			harness: 'claude-code',
			platform: expect.any(String),
			failure_stage: 'spawn_error',
			resolved_binary: false,
			exit_code: undefined,
			classified_reason: 'binary_not_found',
		});
	});
});
