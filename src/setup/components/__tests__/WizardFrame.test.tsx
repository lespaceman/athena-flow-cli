import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect} from 'vitest';
import {Text} from 'ink';
import WizardFrame from '../WizardFrame';
import {ThemeProvider, darkTheme} from '../../../ui/theme/index';

function renderWithTheme(ui: React.ReactElement) {
	return render(<ThemeProvider value={darkTheme}>{ui}</ThemeProvider>);
}

describe('WizardFrame', () => {
	it('renders box-drawing frame with title', () => {
		const {lastFrame} = renderWithTheme(
			<WizardFrame
				title="TEST TITLE"
				header={<Text>header content</Text>}
				footer={<Text>footer content</Text>}
			>
				<Text>body content</Text>
			</WizardFrame>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('┌');
		expect(frame).toContain('TEST TITLE');
		expect(frame).toContain('┘');
		expect(frame).toContain('header content');
		expect(frame).toContain('body content');
		expect(frame).toContain('footer content');
	});

	it('renders tee dividers between zones', () => {
		const {lastFrame} = renderWithTheme(
			<WizardFrame title="T" header={<Text>h</Text>} footer={<Text>f</Text>}>
				<Text>b</Text>
			</WizardFrame>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('├');
		expect(frame).toContain('┤');
	});
});
