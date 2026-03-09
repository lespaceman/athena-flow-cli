import {useMemo} from 'react';
import {useHookContextSelector} from '../providers/RuntimeProvider';

export function useRuntimeSelectors() {
	const feedEvents = useHookContextSelector(v => v.feedEvents);
	const feedItems = useHookContextSelector(v => v.items);
	const tasks = useHookContextSelector(v => v.tasks);

	const session = useHookContextSelector(v => v.session);
	const currentRun = useHookContextSelector(v => v.currentRun);

	const currentPermissionRequest = useHookContextSelector(
		v => v.currentPermissionRequest,
	);
	const permissionQueueCount = useHookContextSelector(
		v => v.permissionQueueCount,
	);
	const resolvePermission = useHookContextSelector(v => v.resolvePermission);
	const currentQuestionRequest = useHookContextSelector(
		v => v.currentQuestionRequest,
	);
	const questionQueueCount = useHookContextSelector(v => v.questionQueueCount);
	const resolveQuestion = useHookContextSelector(v => v.resolveQuestion);
	const isServerRunning = useHookContextSelector(v => v.isServerRunning);
	const runtimeError = useHookContextSelector(v => v.runtimeError);

	const postByToolUseId = useHookContextSelector(v => v.postByToolUseId);
	const allocateSeq = useHookContextSelector(v => v.allocateSeq);
	const clearEvents = useHookContextSelector(v => v.clearEvents);
	const printTaskSnapshot = useHookContextSelector(v => v.printTaskSnapshot);
	const emitNotification = useHookContextSelector(v => v.emitNotification);
	const recordTokens = useHookContextSelector(v => v.recordTokens);
	const restoredTokens = useHookContextSelector(v => v.restoredTokens);

	const hookCommandFeed = useMemo(
		() => ({printTaskSnapshot, emitNotification}),
		[printTaskSnapshot, emitNotification],
	);

	return {
		feedEvents,
		feedItems,
		tasks,
		session,
		currentRun,
		currentPermissionRequest,
		permissionQueueCount,
		resolvePermission,
		currentQuestionRequest,
		questionQueueCount,
		resolveQuestion,
		isServerRunning,
		runtimeError,
		postByToolUseId,
		allocateSeq,
		clearEvents,
		emitNotification,
		recordTokens,
		restoredTokens,
		hookCommandFeed,
	};
}
