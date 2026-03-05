import {useState, useCallback} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import {TextInput} from '@inkjs/ui';
import type {FeedEvent} from '../../core/feed/types';
import OptionList, {type OptionItem} from './OptionList';
import MultiOptionList from './MultiOptionList';
import QuestionKeybindingBar from './QuestionKeybindingBar';
import {getGlyphs} from '../glyphs/index';
import {useTheme} from '../theme/index';

type QuestionOption = {
	label: string;
	description: string;
};

type Question = {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect: boolean;
};

type Props = {
	request: FeedEvent;
	queuedCount: number;
	onAnswer: (answers: Record<string, string>) => void;
	onSkip: () => void;
};

const OTHER_VALUE = '__other__';

function buildOptions(options: QuestionOption[]): OptionItem[] {
	return [
		...options.map(o => ({
			label: o.label,
			description: o.description,
			value: o.label,
		})),
		{
			label: 'Other',
			description: 'Enter a custom response',
			value: OTHER_VALUE,
		},
	];
}

function extractQuestions(request: FeedEvent): Question[] {
	if (request.kind !== 'tool.pre' && request.kind !== 'permission.request')
		return [];
	const toolInput = request.data.tool_input;
	const questions = toolInput.questions as Question[] | undefined;
	return Array.isArray(questions) ? questions : [];
}

function QuestionTabs({
	questions,
	currentIndex,
	answers,
}: {
	questions: Question[];
	currentIndex: number;
	answers: Record<string, string>;
}) {
	const theme = useTheme();
	if (questions.length <= 1) return null;

	return (
		<Box gap={1}>
			{questions.map((q, i) => {
				const answered = q.question in answers;
				const active = i === currentIndex;
				const prefix = answered ? 'x' : `${i + 1}`;
				const label = `${prefix}. ${q.header}`;

				return (
					<Text
						key={`${i}-${q.header}`}
						bold={active}
						color={
							active
								? theme.accent
								: answered
									? theme.status.success
									: theme.textMuted
						}
						dimColor={!active && !answered}
					>
						{active ? `[${label}]` : ` ${label} `}
					</Text>
				);
			})}
		</Box>
	);
}

function SingleQuestion({
	question,
	onAnswer,
	onSkip,
}: {
	question: Question;
	onAnswer: (answer: string) => void;
	onSkip: () => void;
}) {
	const theme = useTheme();
	const [isOther, setIsOther] = useState(false);
	const options = buildOptions(question.options);

	const handleSelect = useCallback(
		(value: string) => {
			if (value === OTHER_VALUE) {
				setIsOther(true);
			} else {
				onAnswer(value);
			}
		},
		[onAnswer],
	);

	const handleOtherSubmit = useCallback(
		(value: string) => {
			if (value.trim()) {
				onAnswer(value.trim());
			}
		},
		[onAnswer],
	);

	useInput((_input, key) => {
		if (key.escape) {
			onSkip();
		}
	});

	if (isOther) {
		return (
			<Box flexDirection="column">
				<Box>
					<Text color={theme.status.warning}>{'> '}</Text>
					<TextInput
						placeholder="Type your answer..."
						onSubmit={handleOtherSubmit}
					/>
				</Box>
				<Box marginTop={1}>
					<QuestionKeybindingBar
						multiSelect={false}
						optionCount={options.length}
					/>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<OptionList options={options} onSelect={handleSelect} />
			<Box marginTop={1}>
				<QuestionKeybindingBar
					multiSelect={false}
					optionCount={options.length}
				/>
			</Box>
		</Box>
	);
}

function MultiQuestion({
	question,
	onAnswer,
	onSkip,
}: {
	question: Question;
	onAnswer: (answer: string) => void;
	onSkip: () => void;
}) {
	const theme = useTheme();
	const [isOther, setIsOther] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const options = buildOptions(question.options);

	const handleSubmit = useCallback(
		(values: string[]) => {
			if (values.includes(OTHER_VALUE)) {
				setSelected(values.filter(v => v !== OTHER_VALUE));
				setIsOther(true);
			} else {
				onAnswer(values.join(', '));
			}
		},
		[onAnswer],
	);

	const handleOtherSubmit = useCallback(
		(value: string) => {
			if (value.trim()) {
				const all = [...selected, value.trim()];
				onAnswer(all.join(', '));
			}
		},
		[onAnswer, selected],
	);

	useInput((_input, key) => {
		if (key.escape) {
			onSkip();
		}
	});

	if (isOther) {
		return (
			<Box flexDirection="column">
				<Box>
					<Text color={theme.status.warning}>{'> '}</Text>
					<TextInput
						placeholder="Type your answer..."
						onSubmit={handleOtherSubmit}
					/>
				</Box>
				<Box marginTop={1}>
					<QuestionKeybindingBar
						multiSelect={true}
						optionCount={options.length}
					/>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<MultiOptionList options={options} onSubmit={handleSubmit} />
			<Box marginTop={1}>
				<QuestionKeybindingBar
					multiSelect={true}
					optionCount={options.length}
				/>
			</Box>
		</Box>
	);
}

export default function QuestionDialog({
	request,
	queuedCount,
	onAnswer,
	onSkip,
}: Props) {
	const questions = extractQuestions(request);
	const [currentIndex, setCurrentIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, string>>({});

	const handleQuestionAnswer = useCallback(
		(answer: string) => {
			const question = questions[currentIndex];

			const newAnswers = {...answers, [question.question]: answer};

			if (currentIndex + 1 < questions.length) {
				setAnswers(newAnswers);
				setCurrentIndex(i => i + 1);
			} else {
				onAnswer(newAnswers);
			}
		},
		[answers, currentIndex, questions, onAnswer],
	);

	const theme = useTheme();

	const {stdout} = useStdout();
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- can be undefined in non-TTY
	const columns = stdout?.columns ?? 80;

	const g = getGlyphs();
	const rule = g['general.divider'].repeat(columns);

	if (questions.length === 0) {
		return (
			<Box flexDirection="column">
				<Text color={theme.dialog.borderQuestion}>{rule}</Text>
				<Box paddingX={1}>
					<Text color={theme.status.warning}>
						No questions found in AskUserQuestion input.
					</Text>
				</Box>
			</Box>
		);
	}

	const question = questions[currentIndex]!;

	return (
		<Box flexDirection="column">
			<Text color={theme.dialog.borderQuestion}>{rule}</Text>

			<Box flexDirection="column" paddingX={1}>
				<QuestionTabs
					questions={questions}
					currentIndex={currentIndex}
					answers={answers}
				/>
				<Box marginTop={questions.length > 1 ? 1 : 0}>
					<Text bold color={theme.accent}>
						[{question.header}]
					</Text>
					<Text> {question.question}</Text>
					{queuedCount > 0 && (
						<Text dimColor> ({queuedCount} more queued)</Text>
					)}
				</Box>
				<Box marginTop={1}>
					{question.multiSelect ? (
						<MultiQuestion
							key={currentIndex}
							question={question}
							onAnswer={handleQuestionAnswer}
							onSkip={onSkip}
						/>
					) : (
						<SingleQuestion
							key={currentIndex}
							question={question}
							onAnswer={handleQuestionAnswer}
							onSkip={onSkip}
						/>
					)}
				</Box>
			</Box>
		</Box>
	);
}
