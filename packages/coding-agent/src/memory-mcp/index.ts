/**
 * Bank-scoped memory MCP server (contract C2, SPEC §4.2, §12.3): wraps mnemopi
 * with one live bank per entity so a single running context can address many
 * banks concurrently, and enforces the agent-vs-persona retention policy at the
 * write path.
 */
export { BankStore, type BankStoreOptions, type RetainMode, type RetainOptions } from "./bank-store";
export {
	type AutoRetainDecision,
	type AutoRetainReason,
	type BankPolicy,
	BankPolicyRegistry,
} from "./policy";
export {
	MemoryMcpServer,
	type MemoryMcpServerOptions,
	SERVER_NAME,
	SERVER_VERSION,
} from "./server";
export {
	FORGET_SCHEMA,
	getToolDefinitions,
	handleToolCall,
	RECALL_SCHEMA,
	RETAIN_SCHEMA,
	RetentionPolicyError,
	type ToolArguments,
	type ToolContext,
	type ToolDefinition,
	type ToolResult,
} from "./tools";
