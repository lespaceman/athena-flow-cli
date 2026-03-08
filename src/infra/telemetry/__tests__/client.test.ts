import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {initTelemetry, shutdownTelemetry, isTelemetryEnabled} from '../client';

// Mock posthog-node at top level
vi.mock('posthog-node', () => {
	const PostHog = vi.fn().mockImplementation(() => ({
		capture: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
	}));
	return {PostHog};
});

describe('telemetry client', () => {
	beforeEach(() => {
		delete process.env['ATHENA_TELEMETRY_DISABLED'];
	});

	afterEach(async () => {
		await shutdownTelemetry();
	});

	it('is enabled by default', () => {
		initTelemetry({deviceId: 'test-id'});
		expect(isTelemetryEnabled()).toBe(true);
	});

	it('is disabled when config telemetry is false', () => {
		initTelemetry({deviceId: 'test-id', telemetryEnabled: false});
		expect(isTelemetryEnabled()).toBe(false);
	});

	it('is disabled when ATHENA_TELEMETRY_DISABLED env var is set', () => {
		process.env['ATHENA_TELEMETRY_DISABLED'] = '1';
		initTelemetry({deviceId: 'test-id'});
		expect(isTelemetryEnabled()).toBe(false);
	});
});
