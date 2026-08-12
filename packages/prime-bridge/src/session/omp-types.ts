export type OmpJsonPrimitive = null | boolean | number | string;
export type OmpJsonValue = OmpJsonPrimitive | OmpJsonValue[] | { [key: string]: OmpJsonValue };
export type OmpJsonObject = { [key: string]: OmpJsonValue };

export interface OmpTextContent {
	readonly type: "text";
	readonly text: string;
	readonly textSignature?: string;
}

export interface OmpImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
	readonly detail?: "auto" | "low" | "high" | "original";
}

export type OmpUserContent = string | Array<OmpTextContent | OmpImageContent>;

export interface OmpOpenAIProviderPayload {
	readonly type: "openaiResponsesHistory";
	readonly provider?: string;
	readonly dt?: boolean;
	readonly items: OmpJsonObject[];
}

export interface OmpContextSnapshot {
	readonly promptTokens: number;
	readonly nonMessageTokens: number;
	readonly historyRewriteTokensRemoved?: number;
	readonly lastMessageTimestamp?: number;
}

export interface OmpUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly contextTokens?: number;
	readonly orchestration?: {
		readonly input?: number;
		readonly cacheRead?: number;
		readonly output?: number;
	};
	readonly premiumRequests?: number;
	readonly reasoningTokens?: number;
	readonly cttl?: {
		readonly ephemeral5m?: number;
		readonly ephemeral1h?: number;
	};
	readonly server?: {
		readonly webSearch?: number;
		readonly webFetch?: number;
	};
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

export interface OmpStopDetails {
	readonly type: string;
	readonly category?: string | null;
	readonly explanation?: string | null;
}

export type OmpAssistantRetryRecovery =
	| {
			readonly kind: "auto-retry";
			readonly status: "recovered";
			readonly attempt: number;
			readonly recoveredAt: string;
			readonly recovery: "credential" | "model" | "wait" | "plain";
			readonly note: string;
			readonly supersededBy?: {
				readonly timestamp: number;
				readonly responseId?: string;
				readonly provider: string;
				readonly model: string;
			};
	  }
	| {
			readonly kind: "auto-retry";
			readonly status: "superseded";
			readonly attempt: number;
			readonly recovery: "credential" | "model" | "wait" | "plain";
			readonly note: string;
	  };

export interface OmpFallbackContent {
	readonly type: "fallback";
	readonly from: { readonly model: string };
	readonly to: { readonly model: string };
}

export type OmpAnthropicServerToolBlock =
	| {
			readonly type: "server_tool_use";
			readonly id: string;
			readonly name: "web_search";
			readonly input?: OmpJsonObject | null;
			readonly [key: string]: OmpJsonValue | undefined;
	  }
	| {
			readonly type: "web_search_tool_result";
			readonly tool_use_id: string;
			readonly content: OmpJsonValue;
			readonly [key: string]: OmpJsonValue | undefined;
	  };

export interface OmpAnthropicServerToolContent {
	readonly type: "anthropicServerTool";
	readonly block: OmpAnthropicServerToolBlock;
}

export interface OmpToolCallProviderMetadata {
	readonly type: "computer";
	readonly providerItemId: string;
	readonly actions: OmpComputerAction[];
	readonly pendingSafetyChecks: OmpComputerSafetyCheck[];
}

export type OmpComputerAction =
	| {
			readonly type: "click";
			readonly button: "left" | "right" | "wheel" | "back" | "forward";
			readonly x: number;
			readonly y: number;
			readonly keys?: string[] | null;
	  }
	| { readonly type: "double_click"; readonly x: number; readonly y: number; readonly keys: string[] | null }
	| {
			readonly type: "drag";
			readonly path: Array<{ readonly x: number; readonly y: number }>;
			readonly keys?: string[] | null;
	  }
	| { readonly type: "keypress"; readonly keys: string[] }
	| { readonly type: "move"; readonly x: number; readonly y: number; readonly keys?: string[] | null }
	| { readonly type: "screenshot" }
	| {
			readonly type: "scroll";
			readonly x: number;
			readonly y: number;
			readonly scroll_x: number;
			readonly scroll_y: number;
			readonly keys?: string[] | null;
	  }
	| { readonly type: "type"; readonly text: string }
	| { readonly type: "wait" };

export interface OmpComputerSafetyCheck {
	readonly id: string;
	readonly code?: string | null;
	readonly message?: string | null;
}

export type OmpComputerScreenshot =
	| { readonly type: "computer_screenshot"; readonly image_url: string }
	| { readonly type: "computer_screenshot"; readonly file_id: string };

export interface OmpToolResultProviderMetadata {
	readonly type: "computer";
	readonly screenshot: OmpComputerScreenshot;
	readonly acknowledgedSafetyChecks: OmpComputerSafetyCheck[];
}

export type OmpAssistantContent =
	| OmpTextContent
	| {
			readonly type: "thinking";
			readonly thinking: string;
			readonly thinkingSignature?: string;
			readonly itemId?: string;
	  }
	| { readonly type: "redactedThinking"; readonly data: string }
	| OmpFallbackContent
	| OmpAnthropicServerToolContent
	| OmpImageContent
	| {
			readonly type: "toolCall";
			readonly id: string;
			readonly name: string;
			readonly arguments: OmpJsonObject;
			readonly thoughtSignature?: string;
			readonly intent?: string;
			readonly rawBlock?: string;
			readonly customWireName?: string;
			readonly providerMetadata?: OmpToolCallProviderMetadata;
	  };

export interface OmpUserMessage {
	readonly role: "user";
	readonly content: OmpUserContent;
	readonly synthetic?: boolean;
	readonly steering?: boolean;
	readonly attribution?: "user" | "agent";
	readonly providerPayload?: OmpOpenAIProviderPayload;
	readonly timestamp: number;
}

export interface OmpDeveloperMessage {
	readonly role: "developer";
	readonly content: OmpUserContent;
	readonly attribution?: "user" | "agent";
	readonly providerPayload?: OmpOpenAIProviderPayload;
	readonly timestamp: number;
}

export interface OmpAssistantMessage {
	readonly role: "assistant";
	readonly content: OmpAssistantContent[];
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	readonly contextSnapshot?: OmpContextSnapshot;
	readonly retryRecovery?: OmpAssistantRetryRecovery;
	readonly responseId?: string;
	readonly upstreamProvider?: string;
	readonly usage: OmpUsage;
	readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
	readonly stopDetails?: OmpStopDetails | null;
	readonly errorMessage?: string;
	readonly toolCallAbortMessages?: { [key: string]: string };
	readonly errorStatus?: number;
	readonly errorId?: number;
	readonly disabledFeatures?: string[];
	readonly providerPayload?: OmpOpenAIProviderPayload;
	readonly timestamp: number;
	readonly duration?: number;
	readonly ttft?: number;
}

export interface OmpToolResultMessage {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: Array<OmpTextContent | OmpImageContent>;
	readonly details?: OmpJsonValue;
	readonly isError: boolean;
	readonly attribution?: "user" | "agent";
	readonly prunedAt?: number;
	readonly providerMetadata?: OmpToolResultProviderMetadata;
	readonly useless?: boolean;
	readonly timestamp: number;
}

export interface OmpCustomMessage {
	readonly role: "custom";
	readonly customType: string;
	readonly content: OmpUserContent;
	readonly display: boolean;
	readonly details?: OmpJsonValue;
	readonly attribution?: "user" | "agent";
	readonly timestamp: number;
}

export interface OmpHookMessage {
	readonly role: "hookMessage";
	readonly customType: string;
	readonly content: OmpUserContent;
	readonly display: boolean;
	readonly details?: OmpJsonValue;
	readonly attribution?: "user" | "agent";
	readonly timestamp: number;
}

export interface OmpExecutionMeta {
	readonly truncation?: {
		readonly direction: "head" | "tail" | "middle";
		readonly truncatedBy: "lines" | "bytes" | "middle";
		readonly totalLines: number;
		readonly totalBytes: number;
		readonly outputLines: number;
		readonly outputBytes: number;
		readonly maxBytes?: number;
		readonly shownRange?: { readonly start: number; readonly end: number };
		readonly headRange?: { readonly start: number; readonly end: number };
		readonly tailRange?: { readonly start: number; readonly end: number };
		readonly elidedBytes?: number;
		readonly elidedLines?: number;
		readonly artifactId?: string;
		readonly nextOffset?: number;
	};
	readonly source?: { readonly type: "path" | "url" | "internal"; readonly value: string };
	readonly diagnostics?: { readonly summary: string; readonly messages: string[] };
	readonly limits?: {
		readonly matchLimit?: { readonly reached: number; readonly suggestion: number };
		readonly resultLimit?: { readonly reached: number; readonly suggestion: number };
		readonly headLimit?: { readonly reached: number; readonly suggestion: number };
		readonly columnTruncated?: { readonly maxColumn: number };
	};
}

export interface OmpBashExecutionMessage {
	readonly role: "bashExecution";
	readonly command: string;
	readonly output: string;
	readonly exitCode?: number;
	readonly cancelled: boolean;
	readonly truncated: boolean;
	readonly meta?: OmpExecutionMeta;
	readonly excludeFromContext?: boolean;
	readonly timestamp: number;
}

export interface OmpPythonExecutionMessage {
	readonly role: "pythonExecution";
	readonly code: string;
	readonly output: string;
	readonly exitCode?: number;
	readonly cancelled: boolean;
	readonly truncated: boolean;
	readonly meta?: OmpExecutionMeta;
	readonly excludeFromContext?: boolean;
	readonly timestamp: number;
}

export interface OmpFileMention {
	readonly path: string;
	readonly content: string;
	readonly lineCount?: number;
	readonly byteSize?: number;
	readonly skippedReason?: "tooLarge" | "binary";
	readonly image?: OmpImageContent;
}

export interface OmpFileMentionMessage {
	readonly role: "fileMention";
	readonly files: OmpFileMention[];
	readonly timestamp: number;
}

export type OmpMessage =
	| OmpUserMessage
	| OmpDeveloperMessage
	| OmpAssistantMessage
	| OmpToolResultMessage
	| OmpCustomMessage
	| OmpHookMessage
	| OmpBashExecutionMessage
	| OmpPythonExecutionMessage
	| OmpFileMentionMessage;

export interface OmpSessionHeader {
	readonly type: "session";
	readonly version: 3;
	readonly id: string;
	readonly timestamp: string;
	readonly cwd: string;
	readonly title?: string;
	readonly titleSource?: "auto" | "user";
	readonly additionalDirectories?: string[];
	readonly parentSession?: string;
	readonly previousSessionFiles?: string[];
	readonly providerPromptCacheKey?: string;
}
export interface OmpSessionTitleSlot {
	readonly type: "title";
	readonly v: 1;
	readonly title: string;
	readonly source?: "auto" | "user";
	readonly updatedAt: string;
	readonly pad: string;
}

export interface OmpSessionEntryBase {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface OmpMessageEntry extends OmpSessionEntryBase {
	readonly type: "message";
	readonly message: OmpMessage;
}

export interface OmpThinkingLevelChangeEntry extends OmpSessionEntryBase {
	readonly type: "thinking_level_change";
	readonly thinkingLevel?: string | null;
	readonly configured?: string | null;
}

export interface OmpModelChangeEntry extends OmpSessionEntryBase {
	readonly type: "model_change";
	readonly model: string;
	readonly role?: string;
	readonly resolvedModelIsFallback?: boolean;
}

export type OmpServiceTier = "auto" | "default" | "flex" | "scale" | "priority";
export type OmpServiceTierByFamily = Partial<Record<"openai" | "anthropic" | "google", OmpServiceTier>>;
export interface OmpServiceTierChangeEntry extends OmpSessionEntryBase {
	readonly type: "service_tier_change";
	readonly serviceTier: OmpServiceTierByFamily | null;
}

export interface OmpCompactionEntry extends OmpSessionEntryBase {
	readonly type: "compaction";
	readonly summary: string;
	readonly shortSummary?: string;
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details?: OmpJsonValue;
	readonly preserveData?: OmpJsonObject;
	readonly fromExtension?: boolean;
	readonly warning?: string;
}

export interface OmpBranchSummaryEntry extends OmpSessionEntryBase {
	readonly type: "branch_summary";
	readonly fromId: string;
	readonly summary: string;
	readonly details?: OmpJsonValue;
	readonly fromExtension?: boolean;
}

export interface OmpResetBoundaryEntry extends OmpSessionEntryBase {
	readonly type: "reset_boundary";
}

export interface OmpCustomEntry extends OmpSessionEntryBase {
	readonly type: "custom";
	readonly customType: string;
	readonly data?: OmpJsonValue;
}

export interface OmpCustomMessageEntry extends OmpSessionEntryBase {
	readonly type: "custom_message";
	readonly customType: string;
	readonly content: OmpUserContent;
	readonly details?: OmpJsonValue;
	readonly display: boolean;
	readonly attribution?: "user" | "agent";
}

export interface OmpLabelEntry extends OmpSessionEntryBase {
	readonly type: "label";
	readonly targetId: string;
	readonly label?: string;
}

export interface OmpTitleChangeEntry extends OmpSessionEntryBase {
	readonly type: "title_change";
	readonly title: string;
	readonly previousTitle?: string;
	readonly source: "auto" | "user";
	readonly trigger?: string;
}

export interface OmpTtsrInjectionEntry extends OmpSessionEntryBase {
	readonly type: "ttsr_injection";
	readonly injectedRules: string[];
}

export interface OmpCredentialPinEntry extends OmpSessionEntryBase {
	readonly type: "credential_pin";
	readonly provider: string;
	readonly hash: string;
}

export interface OmpSessionInitEntry extends OmpSessionEntryBase {
	readonly type: "session_init";
	readonly systemPrompt: string;
	readonly task: string;
	readonly tools: string[];
	readonly agent?: string;
	readonly modelRole?: string;
	readonly resolvedModel?: string;
	readonly readOnly?: boolean;
	readonly outputSchema?: OmpJsonValue;
	readonly outputSchemaMode?: "permissive" | "strict";
	readonly restrictToolNames?: boolean;
	readonly spawns?: string;
	readonly readSummarize?: boolean;
}

export interface OmpModeChangeEntry extends OmpSessionEntryBase {
	readonly type: "mode_change";
	readonly mode: string;
	readonly data?: OmpJsonObject;
}

export type OmpKnownEntry =
	| OmpMessageEntry
	| OmpThinkingLevelChangeEntry
	| OmpModelChangeEntry
	| OmpServiceTierChangeEntry
	| OmpCompactionEntry
	| OmpBranchSummaryEntry
	| OmpResetBoundaryEntry
	| OmpCustomEntry
	| OmpCustomMessageEntry
	| OmpLabelEntry
	| OmpTitleChangeEntry
	| OmpTtsrInjectionEntry
	| OmpCredentialPinEntry
	| OmpSessionInitEntry
	| OmpModeChangeEntry;

export type OmpUnknownEntry = OmpSessionEntryBase & { readonly [key: string]: OmpJsonValue };

export type OmpSessionEntry = OmpKnownEntry | OmpUnknownEntry;
