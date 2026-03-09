import type {AppMode} from '../../shared/types/headerMetrics';

/**
 * Derive the current app mode from runtime state.
 * Priority: permission > question > working > idle.
 *
 * Named as a hook by convention (called in component render path),
 * but is a pure derivation with no React state or effects.
 */
export function useAppMode(
	isClaudeRunning: boolean,
	currentPermissionRequest: unknown | null,
	currentQuestionRequest: unknown | null,
	startupFailureMessage?: string | null,
): AppMode {
	if (startupFailureMessage) {
		return {type: 'startup_failed', message: startupFailureMessage};
	}
	if (!isClaudeRunning) return {type: 'idle'};
	if (currentPermissionRequest) return {type: 'permission'};
	if (currentQuestionRequest) return {type: 'question'};
	return {type: 'working'};
}
