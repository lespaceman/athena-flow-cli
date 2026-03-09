import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {
	disableTelemetry,
	initTelemetry,
	shutdownTelemetry,
	isTelemetryEnabled,
	capture,
} from '../client';

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

	it('capture forwards events to PostHog when enabled', async () => {
		initTelemetry({deviceId: 'test-device-123'});
		capture('test.event', {key: 'value'});

		// Access the mock to verify capture was called
		const {PostHog} = await import('posthog-node');
		const mockResults = vi.mocked(PostHog).mock.results;
		const mockInstance = mockResults[mockResults.length - 1]?.value;
		expect(mockInstance.capture).toHaveBeenCalledWith({
			distinctId: 'test-device-123',
			event: 'test.event',
			properties: {key: 'value'},
		});
	});

	it('capture includes super properties from init options', async () => {
		initTelemetry({
			deviceId: 'test-device-456',
			appVersion: '0.3.10',
			os: 'linux-x64',
		});
		capture('test.event', {key: 'value'});

		const {PostHog} = await import('posthog-node');
		const mockResults = vi.mocked(PostHog).mock.results;
		const mockInstance = mockResults[mockResults.length - 1]?.value;
		expect(mockInstance.capture).toHaveBeenCalledWith({
			distinctId: 'test-device-456',
			event: 'test.event',
			properties: {
				app_version: '0.3.10',
				os: 'linux-x64',
				key: 'value',
			},
		});
	});

	it('event properties override super properties', async () => {
		initTelemetry({
			deviceId: 'test-device-789',
			os: 'linux-x64',
		});
		capture('test.event', {os: 'darwin-arm64'});

		const {PostHog} = await import('posthog-node');
		const mockResults = vi.mocked(PostHog).mock.results;
		const mockInstance = mockResults[mockResults.length - 1]?.value;
		expect(mockInstance.capture).toHaveBeenCalledWith({
			distinctId: 'test-device-789',
			event: 'test.event',
			properties: {os: 'darwin-arm64'},
		});
	});

	it('capture is a no-op when telemetry is disabled', () => {
		initTelemetry({deviceId: 'test-id', telemetryEnabled: false});
		// Should not throw, just silently no-op
		capture('test.event', {key: 'value'});
		// No PostHog instance created, so nothing to verify except no crash
	});

	it('disableTelemetry turns off telemetry immediately for the current process', async () => {
		initTelemetry({deviceId: 'test-id'});
		expect(isTelemetryEnabled()).toBe(true);

		await disableTelemetry();

		expect(isTelemetryEnabled()).toBe(false);
	});
});
