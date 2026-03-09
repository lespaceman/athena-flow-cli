// Client → server methods
export const INITIALIZE = 'initialize';
export const INITIALIZED = 'initialized';
export const THREAD_START = 'thread/start';
export const THREAD_RESUME = 'thread/resume';
export const TURN_START = 'turn/start';
export const TURN_INTERRUPT = 'turn/interrupt';
export const ACCOUNT_READ = 'account/read';
export const MODEL_LIST = 'model/list';

// Server → client notifications
export const TURN_STARTED = 'turn/started';
export const TURN_COMPLETED = 'turn/completed';
export const TURN_DIFF_UPDATED = 'turn/diff/updated';
export const ITEM_STARTED = 'item/started';
export const ITEM_COMPLETED = 'item/completed';
export const ITEM_AGENT_MESSAGE_DELTA = 'item/agentMessage/delta';
export const THREAD_STARTED = 'thread/started';
export const THREAD_STATUS_CHANGED = 'thread/status/changed';
export const THREAD_TOKEN_USAGE_UPDATED = 'thread/tokenUsage/updated';
export const THREAD_NAME_UPDATED = 'thread/name/updated';

// Server → client requests (need response)
export const CMD_EXEC_REQUEST_APPROVAL =
	'item/commandExecution/requestApproval';
export const FILE_CHANGE_REQUEST_APPROVAL = 'item/fileChange/requestApproval';
export const PERMISSIONS_REQUEST_APPROVAL = 'item/permissions/requestApproval';
export const TOOL_REQUEST_USER_INPUT = 'item/tool/requestUserInput';
