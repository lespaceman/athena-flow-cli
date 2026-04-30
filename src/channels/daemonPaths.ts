import os from 'node:os';
import path from 'node:path';

function safeChannelName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function channelDaemonRunDir(homeDir = os.homedir()): string {
	return path.join(homeDir, '.athena', 'run');
}

export function channelDaemonSocketPath(
	channelName: string,
	homeDir = os.homedir(),
): string {
	return path.join(
		channelDaemonRunDir(homeDir),
		`channel-${safeChannelName(channelName)}.sock`,
	);
}
