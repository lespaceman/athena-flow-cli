// src/core/feed/internals/toolCorrelation.ts

/**
 * Correlates tool.pre with later tool.post / tool.failure / tool.delta events
 * by tool_use_id, and tracks streamed tool output with truncation.
 *
 * Invariants:
 *   - recordPre(useId, eventId) lets later events look up the originating
 *     tool.pre event_id via lookupParent(useId).
 *   - lookupParent returns undefined when no pre was seen — orphan post/failure
 *     events still emit, but without a parent_event_id.
 *   - appendDelta accumulates streamed output, truncating when it exceeds the
 *     cap. Once truncated, every subsequent return value carries the truncation
 *     notice prefix.
 *   - forgetTool releases delta accumulators when a tool completes; the parent
 *     index entry is intentionally retained for late events (e.g. errors after
 *     tool.post) until resetForNewRun.
 */
export type ToolCorrelation = {
	recordPre(toolUseId: string, eventId: string): void;
	lookupParent(toolUseId: string | undefined): string | undefined;
	forgetTool(toolUseId: string): void;
	appendDelta(toolUseId: string | undefined, chunk: string): string;
	resetForNewRun(): void;
};

const MAX_STREAMED_TOOL_OUTPUT_CHARS = 64_000;
const STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE =
	'[streaming output truncated to recent content]\n';

export function createToolCorrelation(): ToolCorrelation {
	const toolPreIndex = new Map<string, string>();
	const toolDeltaTextByUseId = new Map<string, string>();
	const truncatedToolDeltaUseIds = new Set<string>();

	return {
		recordPre(toolUseId, eventId) {
			toolPreIndex.set(toolUseId, eventId);
		},
		lookupParent(toolUseId) {
			return toolUseId ? toolPreIndex.get(toolUseId) : undefined;
		},
		forgetTool(toolUseId) {
			toolDeltaTextByUseId.delete(toolUseId);
			truncatedToolDeltaUseIds.delete(toolUseId);
		},
		appendDelta(toolUseId, chunk) {
			if (!toolUseId) return chunk;

			const cumulative = `${toolDeltaTextByUseId.get(toolUseId) ?? ''}${chunk}`;
			if (cumulative.length <= MAX_STREAMED_TOOL_OUTPUT_CHARS) {
				toolDeltaTextByUseId.set(toolUseId, cumulative);
				return truncatedToolDeltaUseIds.has(toolUseId)
					? `${STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE}${cumulative}`
					: cumulative;
			}

			const tail = cumulative.slice(-MAX_STREAMED_TOOL_OUTPUT_CHARS);
			toolDeltaTextByUseId.set(toolUseId, tail);
			truncatedToolDeltaUseIds.add(toolUseId);
			return `${STREAMED_TOOL_OUTPUT_TRUNCATED_NOTICE}${tail}`;
		},
		resetForNewRun() {
			toolPreIndex.clear();
			toolDeltaTextByUseId.clear();
			truncatedToolDeltaUseIds.clear();
		},
	};
}
