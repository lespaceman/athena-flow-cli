export type CodexItemType =
	| 'userMessage'
	| 'agentMessage'
	| 'plan'
	| 'reasoning'
	| 'commandExecution'
	| 'fileChange'
	| 'mcpToolCall'
	| 'webSearch'
	| 'imageView'
	| 'contextCompaction';

export type CodexItemStatus =
	| 'pending'
	| 'inProgress'
	| 'completed'
	| 'failed'
	| 'cancelled';

export type CodexItem = {
	id: string;
	type: CodexItemType;
	status?: CodexItemStatus;
	[key: string]: unknown;
};

export type CodexTurn = {
	id: string;
	status: 'inProgress' | 'completed' | 'interrupted' | 'failed';
	[key: string]: unknown;
};

export type CodexThread = {
	id: string;
	name?: string;
	[key: string]: unknown;
};

export type CodexApprovalDecision =
	| 'accept'
	| 'acceptForSession'
	| 'decline'
	| 'cancel';
