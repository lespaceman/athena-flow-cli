/**
 * Built-in command registration.
 *
 * Imports all built-in commands and registers them with the registry.
 * Call `registerBuiltins()` once at startup.
 */

import {register} from '../registry';

import {helpCommand} from './help';
import {clearCommand} from './clear';
import {quitCommand} from './quit';
import {statsCommand} from './stats';
import {sessionsCommand} from './sessions';
import {contextCommand} from './context';
import {tasksCommand} from './tasks';
import setup from './setup';
import {telemetryCommand} from './telemetry';

const builtins = [
	helpCommand,
	clearCommand,
	quitCommand,
	statsCommand,
	contextCommand,
	sessionsCommand,
	tasksCommand,
	setup,
	telemetryCommand,
];

let registered = false;

export function registerBuiltins(): void {
	if (registered) return;
	registered = true;

	for (const command of builtins) {
		register(command);
	}
}
