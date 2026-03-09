export {
	initTelemetry,
	shutdownTelemetry,
	isTelemetryEnabled,
	disableTelemetry,
} from './client';
export {generateDeviceId, isValidDeviceId} from './identity';
export {
	trackAppLaunched,
	trackClaudeStartupFailed,
	trackSessionStarted,
	trackSessionEnded,
	trackError,
	trackTelemetryOptedOut,
} from './events';
