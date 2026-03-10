// Client → server methods
export const INITIALIZE = 'initialize';
export const INITIALIZED = 'initialized';
export const THREAD_START = 'thread/start';
export const THREAD_RESUME = 'thread/resume';
export const TURN_START = 'turn/start';
export const TURN_INTERRUPT = 'turn/interrupt';
export const ACCOUNT_READ = 'account/read';
export const MODEL_LIST = 'model/list';
export const SKILLS_LIST = 'skills/list';

// Server → client notifications
export const TURN_STARTED = 'turn/started';
export const TURN_COMPLETED = 'turn/completed';
export const TURN_DIFF_UPDATED = 'turn/diff/updated';
export const TURN_PLAN_UPDATED = 'turn/plan/updated';
export const ITEM_STARTED = 'item/started';
export const ITEM_COMPLETED = 'item/completed';
export const ITEM_COMMAND_EXECUTION_OUTPUT_DELTA =
	'item/commandExecution/outputDelta';
export const ITEM_AGENT_MESSAGE_DELTA = 'item/agentMessage/delta';
export const ITEM_PLAN_DELTA = 'item/plan/delta';
export const ITEM_REASONING_SUMMARY_TEXT_DELTA =
	'item/reasoning/summaryTextDelta';
export const ITEM_REASONING_SUMMARY_PART_ADDED =
	'item/reasoning/summaryPartAdded';
export const ITEM_REASONING_TEXT_DELTA = 'item/reasoning/textDelta';
export const THREAD_STARTED = 'thread/started';
export const SKILLS_CHANGED = 'skills/changed';
export const THREAD_STATUS_CHANGED = 'thread/status/changed';
export const THREAD_TOKEN_USAGE_UPDATED = 'thread/tokenUsage/updated';
export const THREAD_NAME_UPDATED = 'thread/name/updated';

// Server → client requests (need response)
export const CMD_EXEC_REQUEST_APPROVAL =
	'item/commandExecution/requestApproval';
export const FILE_CHANGE_REQUEST_APPROVAL = 'item/fileChange/requestApproval';
export const TOOL_REQUEST_USER_INPUT = 'item/tool/requestUserInput';
export const MCP_SERVER_ELICITATION_REQUEST = 'mcpServer/elicitation/request';
export const DYNAMIC_TOOL_CALL = 'item/tool/call';
export const CHATGPT_AUTH_TOKENS_REFRESH = 'account/chatgptAuthTokens/refresh';
export const APPLY_PATCH_APPROVAL = 'applyPatchApproval';
export const EXEC_COMMAND_APPROVAL = 'execCommandApproval';
