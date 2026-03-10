import type {
	CodexCommandExecutionApprovalDecision,
	CodexFileChangeApprovalDecision,
	CodexItem as GeneratedCodexItem,
	CodexThread as GeneratedCodexThread,
	CodexTurn as GeneratedCodexTurn,
} from './index';

export type CodexItem = GeneratedCodexItem;
export type CodexTurn = GeneratedCodexTurn;
export type CodexThread = GeneratedCodexThread;
export type CodexApprovalDecision =
	| Extract<CodexCommandExecutionApprovalDecision, string>
	| CodexFileChangeApprovalDecision;
