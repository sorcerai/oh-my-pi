import type { JsonValue } from "./spec";

export type PrimeJsonObject = { [key: string]: JsonValue };
export type PrimeServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;

export interface PrimeGitContext {
	repoUrl?: string;
	commit?: string;
	branch?: string;
}

export interface PrimeSessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	rlmDepth?: number;
	git?: PrimeGitContext;
}

export interface PrimeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface PrimeTextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface PrimeImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PrimeThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}
export interface PrimeToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: PrimeJsonObject;
	thoughtSignature?: string;
}

export interface PrimeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}
export interface PrimeDiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface PrimeAssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: PrimeDiagnosticErrorInfo;
	details?: PrimeJsonObject;
}

export type PrimeStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface PrimeUserMessage {
	role: "user";
	content: string | Array<PrimeTextContent | PrimeImageContent>;
	timestamp: number;
}

export interface PrimeAssistantMessage {
	role: "assistant";
	content: Array<PrimeTextContent | PrimeThinkingContent | PrimeToolCallContent>;
	api: string;
	provider: string;
	model: string;
	usage: PrimeUsage;
	stopReason: PrimeStopReason;
	timestamp: number;
	responseModel?: string;
	responseId?: string;
	diagnostics?: PrimeAssistantMessageDiagnostic[];
	stopReasonRaw?: string;
	errorMessage?: string;
}

export interface PrimeToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<PrimeTextContent | PrimeImageContent>;
	details?: JsonValue;
	isError: boolean;
	timestamp: number;
}
export interface PrimeBashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	timestamp: number;
}

export interface PrimeCustomMessage {
	role: "custom";
	customType: string;
	content: string | Array<PrimeTextContent | PrimeImageContent>;
	display: boolean;
	details?: JsonValue;
	timestamp: number;
}

export interface PrimeBranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface PrimeCompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	retainedMessageCount?: number;
	customInstructions?: string;
	timestamp: number;
}

export type PrimeAgentMessage =
	| PrimeUserMessage
	| PrimeAssistantMessage
	| PrimeToolResultMessage
	| PrimeBashExecutionMessage
	| PrimeCustomMessage
	| PrimeBranchSummaryMessage
	| PrimeCompactionSummaryMessage;

export interface PrimeMessageEntry extends PrimeEntryBase {
	type: "message";
	message: PrimeAgentMessage;
}

export interface PrimeModelChangeEntry extends PrimeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface PrimeThinkingLevelChangeEntry extends PrimeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}
export interface PrimeServiceTierChangeEntry extends PrimeEntryBase {
	type: "service_tier_change";
	serviceTier: PrimeServiceTier;
}

export interface PrimeCompactionEntry extends PrimeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: JsonValue;
	fromHook?: boolean;
	customInstructions?: string;
}

export interface PrimeBranchSummaryEntry extends PrimeEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: JsonValue;
	fromHook?: boolean;
}

export interface PrimeCustomEntry extends PrimeEntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

export interface PrimeChildUsageAttributionEntry extends PrimeEntryBase {
	type: "child_usage_attributed";
	targetId: string;
	childUsage: PrimeUsage;
	aggregateUsage: PrimeUsage;
	origin?: "spawn_task" | "agent_message" | "direct_user";
}

export interface PrimeCustomMessageEntry extends PrimeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | Array<PrimeTextContent | PrimeImageContent>;
	details?: JsonValue;
	display: boolean;
}

export interface PrimeLabelEntry extends PrimeEntryBase {
	type: "label";
	targetId: string;
	label?: string;
}

export interface PrimeSessionInfoEntry extends PrimeEntryBase {
	type: "session_info";
	name?: string;
}

export type PrimeSessionStateStatus = "active" | "archived" | "crash";
export interface PrimeSessionStateEntry extends PrimeEntryBase {
	type: "session_state";
	state: { status: PrimeSessionStateStatus };
}

export type PrimeAgentTaskState = "needs_input" | "completed";
export interface PrimeAgentStatusEntry extends PrimeEntryBase {
	type: "agent_status";
	status: { summary: string; taskState?: PrimeAgentTaskState; basedOnMessageCount: number };
}

export interface PrimeGitStateEntry extends PrimeEntryBase {
	type: "git_state";
	git: PrimeGitContext;
}

export interface PrimeUnknownEntry extends PrimeEntryBase {
	type: Exclude<string, KnownPrimeEntryType>;
	[key: string]: JsonValue;
}

export type KnownPrimeEntryType =
	| "message"
	| "model_change"
	| "thinking_level_change"
	| "service_tier_change"
	| "compaction"
	| "branch_summary"
	| "custom"
	| "child_usage_attributed"
	| "custom_message"
	| "label"
	| "session_info"
	| "session_state"
	| "agent_status"
	| "git_state";

export type PrimeSessionEntry =
	| PrimeMessageEntry
	| PrimeModelChangeEntry
	| PrimeThinkingLevelChangeEntry
	| PrimeServiceTierChangeEntry
	| PrimeCompactionEntry
	| PrimeBranchSummaryEntry
	| PrimeCustomEntry
	| PrimeChildUsageAttributionEntry
	| PrimeCustomMessageEntry
	| PrimeLabelEntry
	| PrimeSessionInfoEntry
	| PrimeSessionStateEntry
	| PrimeAgentStatusEntry
	| PrimeGitStateEntry;

export type PrimeFileObject = PrimeSessionHeader | PrimeSessionEntry;
