import {PostHog} from 'posthog-node';

// PostHog API key is injected at build time by tsup's `define` option.
// The env var POSTHOG_API_KEY must be set during `npm run build` (e.g. in CI
// via a GitHub Actions secret). When absent the key is empty and telemetry
// silently no-ops — this is the expected behaviour for local dev builds.
const POSTHOG_API_KEY: string =
	typeof __POSTHOG_API_KEY__ === 'string' ? __POSTHOG_API_KEY__ : '';
const POSTHOG_HOST = 'https://us.i.posthog.com';

declare const __POSTHOG_API_KEY__: string | undefined;

let client: PostHog | null = null;
let deviceId: string | null = null;
let enabled = false;

export type TelemetryInitOptions = {
	deviceId: string;
	telemetryEnabled?: boolean;
};

export function initTelemetry(options: TelemetryInitOptions): void {
	const envDisabled = process.env['ATHENA_TELEMETRY_DISABLED'] === '1';
	const hasKey = POSTHOG_API_KEY.length > 0;
	enabled = hasKey && (options.telemetryEnabled ?? true) && !envDisabled;

	if (!enabled) {
		return;
	}

	deviceId = options.deviceId;
	client = new PostHog(POSTHOG_API_KEY, {
		host: POSTHOG_HOST,
		disableGeoip: true,
		flushAt: 20,
		flushInterval: 30000,
	});
}

export function isTelemetryEnabled(): boolean {
	return enabled;
}

export function disableTelemetry(): Promise<void> {
	enabled = false;
	deviceId = null;
	if (!client) {
		return Promise.resolve();
	}

	const currentClient = client;
	client = null;
	return currentClient.shutdown();
}

export function capture(
	event: string,
	properties?: Record<string, unknown>,
): void {
	if (!enabled || !client || !deviceId) {
		return;
	}

	client.capture({
		distinctId: deviceId,
		event,
		properties,
	});
}

export async function shutdownTelemetry(): Promise<void> {
	if (client) {
		await client.shutdown();
		client = null;
	}
	deviceId = null;
	enabled = false;
}
