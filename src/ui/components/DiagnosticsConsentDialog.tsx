import {useCallback, useMemo} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import {getGlyphs} from '../glyphs/index';
import {useTheme} from '../theme/index';
import OptionList, {type OptionItem} from './OptionList';

export type DiagnosticsConsentDecision =
	| 'send-once'
	| 'always-send'
	| 'do-not-send';

type Props = {
	harnessLabel: string;
	onDecision: (decision: DiagnosticsConsentDecision) => void;
};

export default function DiagnosticsConsentDialog({
	harnessLabel,
	onDecision,
}: Props) {
	const theme = useTheme();
	const g = getGlyphs();
	const {stdout} = useStdout();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be undefined in non-TTY
	const columns = stdout?.columns ?? 80;
	const rule = g['general.divider'].repeat(columns);

	const options: OptionItem[] = useMemo(
		() => [
			{label: 'Send once', value: 'send-once'},
			{
				label: 'Always send anonymous diagnostics',
				value: 'always-send',
			},
			{label: 'Do not send', value: 'do-not-send'},
		],
		[],
	);

	const handleSelect = useCallback(
		(value: string) => {
			onDecision(value as DiagnosticsConsentDecision);
		},
		[onDecision],
	);

	useInput((_input, key) => {
		if (key.escape) onDecision('do-not-send');
	});

	return (
		<Box flexDirection="column">
			<Text color={theme.dialog.borderPermission}>{rule}</Text>

			<Box flexDirection="column" paddingX={1}>
				<Text bold color={theme.dialog.borderPermission}>
					Send anonymous {harnessLabel} startup diagnostics?
				</Text>

				<Box marginTop={1} flexDirection="column">
					<Text dimColor>
						Athena can send a sanitized failure report to help debug startup
						issues.
					</Text>
					<Text dimColor>
						Includes only coarse fields like platform, failure stage, exit code,
						and classified reason.
					</Text>
					<Text dimColor>
						Does not include prompts, stderr, file paths, or session content.
					</Text>
				</Box>

				<Box marginTop={1}>
					<OptionList options={options} onSelect={handleSelect} />
				</Box>

				<Box marginTop={1} gap={2}>
					<Text>
						<Text dimColor>up/down</Text> Navigate
					</Text>
					<Text>
						<Text dimColor>1-{options.length}</Text> Jump
					</Text>
					<Text>
						<Text dimColor>Enter</Text> Select
					</Text>
					<Text>
						<Text dimColor>Esc</Text> Decline
					</Text>
				</Box>
			</Box>
		</Box>
	);
}
