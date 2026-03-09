import {type UICommand} from '../types';
import {
	disableTelemetry,
	isTelemetryEnabled,
	trackTelemetryOptedOut,
} from '../../../infra/telemetry/index';
import {writeGlobalConfig} from '../../../infra/plugins/config';
import {generateId} from '../../../harnesses/claude/protocol/index';

export const telemetryCommand: UICommand = {
	name: 'telemetry',
	description:
		'Manage anonymous telemetry (usage: /telemetry enable | /telemetry disable | /telemetry status)',
	category: 'ui',
	args: [
		{
			name: 'action',
			description: 'enable, disable, or status',
			required: false,
		},
	],
	execute(ctx) {
		const action = ctx.args['action'] ?? 'status';

		switch (action) {
			case 'enable':
				writeGlobalConfig({telemetry: true});
				ctx.addMessage({
					id: generateId(),
					role: 'assistant',
					content:
						'Telemetry enabled. Anonymous usage data will be collected on next launch.',
					timestamp: new Date(),
				});
				break;

			case 'disable':
				trackTelemetryOptedOut();
				void disableTelemetry();
				writeGlobalConfig({telemetry: false});
				ctx.addMessage({
					id: generateId(),
					role: 'assistant',
					content:
						'Telemetry disabled. No anonymous usage data will be collected in this session or future launches.',
					timestamp: new Date(),
				});
				break;

			case 'status':
				ctx.addMessage({
					id: generateId(),
					role: 'assistant',
					content: `Telemetry is currently ${isTelemetryEnabled() ? 'enabled' : 'disabled'}.`,
					timestamp: new Date(),
				});
				break;

			default:
				ctx.addMessage({
					id: generateId(),
					role: 'assistant',
					content:
						'Unknown action. Usage: /telemetry enable | /telemetry disable | /telemetry status',
					timestamp: new Date(),
				});
		}
	},
};
