import {PostHog} from 'posthog-node';

// PostHog write-only API key (safe to embed — cannot read data)
const POSTHOG_API_KEY = 'phc_PLACEHOLDER_REPLACE_WITH_REAL_KEY';
const POSTHOG_HOST = 'https://us.i.posthog.com';

let client: PostHog | null = null;
let deviceId: string | null = null;
let enabled = false;

export type TelemetryInitOptions = {
	deviceId: string;
	telemetryEnabled?: boolean;
};

export function initTelemetry(options: TelemetryInitOptions): void {
	const envDisabled = process.env['ATHENA_TELEMETRY_DISABLED'] === '1';
	enabled = (options.telemetryEnabled ?? true) && !envDisabled;

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
