import {type UICommand} from '../types';

export const workflowCommand: UICommand = {
	name: 'workflow',
	description: 'Change the active workflow for this project',
	category: 'ui',
	execute: ctx => {
		ctx.showWorkflowPicker();
	},
};
