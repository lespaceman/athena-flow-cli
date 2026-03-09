import {describe, it, expect, vi} from 'vitest';
import {tasksCommand} from '../builtins/tasks';
import type {HookCommandContext} from '../types';

describe('tasks command', () => {
	it('has correct name and category', () => {
		expect(tasksCommand.name).toBe('tasks');
		expect(tasksCommand.category).toBe('hook');
	});

	it('calls feed.printTaskSnapshot', () => {
		const printTaskSnapshot = vi.fn();
		const ctx: HookCommandContext = {
			args: {},
			feed: {printTaskSnapshot},
		};
		tasksCommand.execute(ctx);
		expect(printTaskSnapshot).toHaveBeenCalled();
	});
});
