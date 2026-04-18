import {type UICommand} from '../types';

export const modelCommand: UICommand = {
	name: 'model',
	description: 'Change the preferred model for this project',
	category: 'ui',
	execute: ctx => {
		ctx.showModelPicker();
	},
};
