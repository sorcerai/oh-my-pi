import packageJson from "../../package.json" with { type: "json" };
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { kCursorExecResolved, kStreamingBlockIndex, kStreamingBlockKind } from "../utils/block-symbols";
import { createAssistantMessageEventStream } from "../utils/event-stream";
import {
	type ClaudeAgentSdkOptions,
	type ClaudeSdkPermissionResult,
	claudeCodeEffort,
	claudeCodeToolDisplayName,
} from "./claude-agent-sdk-types";

type QueryFn = (params: { prompt: unknown; options?: Record<string, unknown> }) => AsyncIterable<unknown>;

let queryOverride: QueryFn | undefined;

/** Test seam: inject a fake `query`. */
export function setClaudeSdkQueryForTests(fn: QueryFn | undefined): void {
	queryOverride = fn;
}

/**
 * The SDK is loaded lazily so importing this module never pulls in the
 * Claude Code binary bridge for users who never select the provider.
 */
async function loadQuery(): Promise<QueryFn> {
	if (queryOverride) return queryOverride;
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	return sdk.query as unknown as QueryFn;
}

function resolveExecutable(): string | undefined {
	const fromEnv = process.env.OMP_CLAUDE_CODE_EXECUTABLE?.trim();
	if (fromEnv) return fromEnv;
	return Bun.which("claude") ?? undefined;
}

type SettingSource = "user" | "project" | "local";
const SETTING_SOURCES: readonly SettingSource[] = ["user", "project", "local"];
/**
 * Which Claude Code settings files the subprocess loads. Default drops `user`
 * so the operator's global `~/.claude/settings.json` hooks (e.g. a Stop hook
 * that starts extra turns) never run inside an omp turn; `project` stays so
 * CLAUDE.md and project settings still apply. `OMP_CLAUDE_CODE_SETTING_SOURCES`
 * overrides with a comma list, `all` to match the CLI default, `none` to
 * isolate completely.
 */
export function resolveSettingSources(env: NodeJS.ProcessEnv = process.env): SettingSource[] | undefined {
	const raw = env.OMP_CLAUDE_CODE_SETTING_SOURCES?.trim().toLowerCase();
	if (!raw) return ["project", "local"];
	if (raw === "all") return undefined;
	if (raw === "none") return [];
	return raw
		.split(",")
		.map(s => s.trim())
		.filter((s): s is SettingSource => (SETTING_SOURCES as readonly string[]).includes(s));
}

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// `Message["content"]` is a union of array types, so a `p is TextContent`
	// filter predicate does not narrow through it. Walk it structurally instead.
	const parts: string[] = [];
	for (const p of content as { type?: string; text?: string }[]) {
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.join("\n");
}

function lastUserMessage(context: Context): Message | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		if (context.messages[i].role === "user") return context.messages[i];
	}
	return undefined;
}

function flattenHistory(context: Context): string {
	return context.messages
		.filter(m => m.role === "user" || m.role === "assistant")
		.map(m => `${m.role}: ${textOf(m.content as Message["content"])}`.trim())
		.filter(Boolean)
		.join("\n\n");
}

function imagesOf(content: Message["content"]): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return (content as { type?: string }[]).filter((p): p is ImageContent => p.type === "image");
}

/**
 * The SDK takes either a plain string or an async iterable of SDK user
 * messages. Images only survive the second form, so text-only turns keep the
 * cheaper string and only an image-bearing turn pays for the iterable.
 */
function buildPrompt(text: string, images: ImageContent[]): string | AsyncIterable<unknown> {
	if (images.length === 0) return text;
	const message = {
		type: "user" as const,
		parent_tool_use_id: null,
		message: {
			role: "user" as const,
			content: [
				...images.map(img => ({
					type: "image" as const,
					source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
				})),
				{ type: "text" as const, text },
			],
		},
	};
	return {
		async *[Symbol.asyncIterator]() {
			yield message;
		},
	};
}

function isLoginError(message: string): boolean {
	return /not logged in|\/login|authentication|invalid api key|please run .*login/i.test(message);
}

/**
 * A `resume` id the CLI no longer knows about. Claude Code prunes its own
 * session store, so a persisted id outlives the session it names. Actual
 * strings from the CLI: "No conversation found with session ID: <id>",
 * "No conversation found to continue", "Could not resume session <id> — its
 * environment has expired", "Unable to load transcript from file".
 */
function isUnknownSessionError(message: string): boolean {
	return /no conversation found|could not resume|unable to load transcript|session[^.]*\b(not found|does not exist|expired|unknown|invalid)|(not found|does not exist|expired|unknown|invalid)[^.]*\bsession/i.test(
		message,
	);
}

export const streamClaudeAgentSdk: StreamFunction<"claude-agent-sdk"> = (
	model: Model<"claude-agent-sdk">,
	context: Context,
	options?: ClaudeAgentSdkOptions,
): AssistantMessageEventStream => {
	const stream = createAssistantMessageEventStream();
	const handlers = options?.claudeSdkHandlers;
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "claude-agent-sdk",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		// Reassigned per attempt: the retry below needs a controller that the
		// failed attempt cannot have aborted from the inside.
		let abort = new AbortController();
		const onAbort = () => abort.abort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		// SDK stream block index -> index in output.content.
		const openBlocks = new Map<number, number>();
		// SDK block indexes that opened a streaming block. Recorded at
		// content_block_start, NOT at content_block_stop: the SDK emits the full
		// `assistant` message BEFORE content_block_stop, so a stop-keyed set is
		// always empty when the assistant fallback reads it and every streamed
		// block gets emitted twice. Keyed by SDK index, not content index: a
		// message where only block 0 streamed must still emit block 1's text
		// from the full `assistant` message.
		const streamedSdkIndexes = new Set<number>();
		// Per-stream, not module-level: two concurrent turns must not share
		// tool-id -> name state, or a result pairs against the wrong call.
		const toolNamesById = new Map<string, string>();
		// tool_use ids emitted but not yet answered by a tool_result.
		const pendingToolUseIds = new Set<string>();
		let started = false;
		const ensureStart = () => {
			if (started) return;
			started = true;
			stream.push({ type: "start", partial: output });
		};
		// A toolCall marked kCursorExecResolved is skipped by the agent loop, so
		// nothing else will ever produce a result for it. Left unpaired it is an
		// unanswered call in the transcript, which rebuild reads as freshly
		// runnable on resume. Answer every one before the turn ends.
		const settlePendingToolCalls = async () => {
			const onToolResult = options?.onToolResult;
			if (!onToolResult) return;
			for (const id of pendingToolUseIds) {
				await onToolResult({
					role: "toolResult",
					toolCallId: id,
					toolName: toolNamesById.get(id) ?? "tool",
					content: [{ type: "text", text: "Claude Code turn ended before this tool returned a result" }],
					isError: true,
					timestamp: Date.now(),
				});
			}
			pendingToolUseIds.clear();
		};

		try {
			const query = await loadQuery();
			let resumeId = handlers?.getSdkSessionId();
			// Fail closed: with no host bridge there is nothing to approve
			// against, and registering a blanket-allow callback would be
			// bypassPermissions by another name. With no callback the SDK
			// makes every "ask" decision a terminal denial, so nothing is
			// auto-approved beyond its own default allow rules.
			const canUseTool = handlers
				? async (
						toolName: string,
						input: Record<string, unknown>,
						opts: { signal: AbortSignal },
					): Promise<ClaudeSdkPermissionResult> =>
						handlers.requestToolPermission({ toolName, input, signal: opts.signal })
				: undefined;
			// At most one recovery attempt. Claude Code prunes its session
			// store, so a persisted `resume` id can name a session that no
			// longer exists and fails the whole turn. Drop the id and replay
			// the flattened history once.
			//
			// Retry only while nothing has reached the stream: a second
			// `ensureStart()` is a no-op, so a retry after partial content
			// would splice two turns into one message. If content was already
			// emitted the error is surfaced as-is.
			let retried = false;
			const canRetryResume = (message: string) =>
				!retried &&
				resumeId !== undefined &&
				!started &&
				output.content.length === 0 &&
				!abort.signal.aborted &&
				!options?.signal?.aborted &&
				isUnknownSessionError(message);
			const beginRetry = () => {
				retried = true;
				resumeId = undefined;
				handlers?.resetSdkSession();
			};

			attempts: for (;;) {
				abort = new AbortController();
				if (options?.signal?.aborted) abort.abort();
				const last = lastUserMessage(context);
				const lastContent = (last?.content ?? "") as Message["content"];
				const promptText = resumeId ? textOf(lastContent) : flattenHistory(context);
				const prompt = buildPrompt(promptText, imagesOf(lastContent));
				const effort = claudeCodeEffort(options?.reasoning);
				const settingSources = resolveSettingSources();

				// `query()` is inside the try: it can reject the resume id
				// synchronously, and that failure has to reach the retry too.
				try {
					const q = query({
						prompt,
						options: {
							model: model.id,
							cwd: options?.cwd,
							resume: resumeId,
							includePartialMessages: true,
							abortController: abort,
							systemPrompt: {
								type: "preset",
								preset: "claude_code",
								append: context.systemPrompt?.length ? context.systemPrompt.join("\n\n") : undefined,
							},
							...(effort ? { effort } : {}),
							...(canUseTool ? { canUseTool } : {}),
							pathToClaudeCodeExecutable: resolveExecutable(),
							...(settingSources ? { settingSources } : {}),
							env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `oh-my-pi/${packageJson.version}` },
						},
					});
					for await (const raw of q) {
						const msg = raw as Record<string, unknown>;
						if (abort.signal.aborted) break;
						switch (msg.type) {
							case "system": {
								if (msg.subtype === "init" && typeof msg.session_id === "string")
									handlers?.setSdkSessionId(msg.session_id);
								break;
							}
							case "rate_limit_event": {
								handlers?.onRateLimit?.(msg.rate_limit_info);
								break;
							}
							case "stream_event": {
								if (msg.parent_tool_use_id) break;
								ensureStart();
								handleStreamEvent(
									msg.event as Record<string, unknown>,
									output,
									stream,
									openBlocks,
									streamedSdkIndexes,
								);
								break;
							}
							case "assistant": {
								if (msg.parent_tool_use_id) break;
								ensureStart();
								handleAssistantMessage(
									msg.message as { content: unknown[] },
									output,
									stream,
									streamedSdkIndexes,
									toolNamesById,
									pendingToolUseIds,
								);
								break;
							}
							case "user": {
								if (msg.parent_tool_use_id) break;
								await handleUserMessage(
									msg.message as { content: unknown },
									options?.onToolResult,
									toolNamesById,
									pendingToolUseIds,
								);
								break;
							}
							case "result": {
								const errText = msg.is_error
									? Array.isArray(msg.errors)
										? msg.errors.join("; ")
										: String(msg.result ?? msg.subtype ?? "Claude Code failed")
									: "";
								// Tested before ensureStart(): that call flips `started`,
								// which would make the retry guard unsatisfiable.
								if (msg.is_error && canRetryResume(errText)) {
									beginRetry();
									continue attempts;
								}
								ensureStart();
								closeOpenBlocks(output, stream, openBlocks);
								await settlePendingToolCalls();
								applyUsage(output, msg.usage as Record<string, number> | undefined);
								if (msg.is_error) {
									output.stopReason = "error";
									output.errorMessage = errText;
									stream.push({ type: "error", reason: "error", error: output });
									return;
								}
								output.stopReason = "stop";
								stream.push({ type: "done", reason: "stop", message: output });
								return;
							}
							default:
								break;
						}
					}
					// Generator ended without a result message.
					ensureStart();
					closeOpenBlocks(output, stream, openBlocks);
					await settlePendingToolCalls();
					if (abort.signal.aborted) {
						output.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
					} else {
						stream.push({ type: "done", reason: "stop", message: output });
					}
					return;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (!canRetryResume(message)) throw err;
					beginRetry();
				}
			}
		} catch (err) {
			ensureStart();
			closeOpenBlocks(output, stream, openBlocks);
			await settlePendingToolCalls();
			const message = err instanceof Error ? err.message : String(err);
			if (abort.signal.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = message;
				stream.push({ type: "error", reason: "aborted", error: output });
				return;
			}
			output.stopReason = "error";
			output.errorMessage = isLoginError(message)
				? `Claude Code is not logged in. Run 'claude login' in a terminal, then retry. (${message})`
				: message;
			stream.push({ type: "error", reason: "error", error: output });
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			stream.end();
		}
	})();

	return stream;
};

function handleStreamEvent(
	event: Record<string, unknown>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	openBlocks: Map<number, number>,
	streamedSdkIndexes: Set<number>,
): void {
	const index = Number(event.index ?? -1);
	switch (event.type) {
		case "content_block_start": {
			const block = event.content_block as { type?: string } | undefined;
			if (block?.type === "text") {
				output.content.push({ type: "text", text: "" });
				openBlocks.set(index, output.content.length - 1);
				streamedSdkIndexes.add(index);
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			} else if (block?.type === "thinking") {
				output.content.push({ type: "thinking", thinking: "" } satisfies ThinkingContent);
				openBlocks.set(index, output.content.length - 1);
				streamedSdkIndexes.add(index);
				stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
			}
			// tool_use blocks are taken from the full `assistant` message instead.
			break;
		}
		case "content_block_delta": {
			const ci = openBlocks.get(index);
			if (ci === undefined) break;
			const delta = event.delta as { type?: string; text?: string; thinking?: string };
			const target = output.content[ci];
			if (delta.type === "text_delta" && target.type === "text") {
				target.text += delta.text ?? "";
				stream.push({ type: "text_delta", contentIndex: ci, delta: delta.text ?? "", partial: output });
			} else if (delta.type === "thinking_delta" && target.type === "thinking") {
				target.thinking += delta.thinking ?? "";
				stream.push({ type: "thinking_delta", contentIndex: ci, delta: delta.thinking ?? "", partial: output });
			}
			break;
		}
		case "content_block_stop": {
			const ci = openBlocks.get(index);
			if (ci === undefined) break;
			openBlocks.delete(index);
			endBlock(output, stream, ci);
			break;
		}
		default:
			break;
	}
}

function endBlock(output: AssistantMessage, stream: AssistantMessageEventStream, ci: number): void {
	const target = output.content[ci];
	if (target.type === "text")
		stream.push({ type: "text_end", contentIndex: ci, content: target.text, partial: output });
	else if (target.type === "thinking")
		stream.push({ type: "thinking_end", contentIndex: ci, content: target.thinking, partial: output });
}

function closeOpenBlocks(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	openBlocks: Map<number, number>,
): void {
	for (const ci of openBlocks.values()) endBlock(output, stream, ci);
	openBlocks.clear();
}

function handleAssistantMessage(
	message: { content: unknown[] },
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	streamedSdkIndexes: Set<number>,
	toolNamesById: Map<string, string>,
	pendingToolUseIds: Set<string>,
): void {
	for (const [sdkIndex, raw] of (message.content ?? []).entries()) {
		const block = raw as {
			type: string;
			id?: string;
			name?: string;
			input?: Record<string, unknown>;
			text?: string;
		};
		if (block.type === "tool_use" && block.id && block.name) {
			const name = claudeCodeToolDisplayName(block.name);
			toolNamesById.set(block.id, name);
			pendingToolUseIds.add(block.id);
			const toolCall: ToolCall & Record<symbol, unknown> = {
				type: "toolCall",
				id: block.id,
				name,
				arguments: block.input ?? {},
				[kStreamingBlockIndex]: output.content.length,
				[kStreamingBlockKind]: "claude-sdk",
				[kCursorExecResolved]: true,
			};
			output.content.push(toolCall);
			const ci = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: ci, toolCall, partial: output });
		} else if (block.type === "text" && !streamedSdkIndexes.has(sdkIndex) && block.text) {
			// Non-streaming fallback: no stream_event opened a block at THIS
			// index, so its text never reached the stream.
			output.content.push({ type: "text", text: block.text });
			const ci = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: ci, partial: output });
			stream.push({ type: "text_delta", contentIndex: ci, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: output });
		}
	}
	// SDK block indexes restart at 0 for every assistant message. Cleared at
	// the end, not the start: this message's own streamed blocks still have to
	// be recognised as already-emitted by the loop above.
	streamedSdkIndexes.clear();
}

async function handleUserMessage(
	message: { content: unknown },
	onToolResult: ClaudeAgentSdkOptions["onToolResult"],
	toolNamesById: Map<string, string>,
	pendingToolUseIds: Set<string>,
): Promise<void> {
	if (!Array.isArray(message.content)) return;
	for (const raw of message.content) {
		const block = raw as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
		if (block.type !== "tool_result" || !block.tool_use_id) continue;
		// Answered, so the terminal paths must not synthesize a result for it.
		pendingToolUseIds.delete(block.tool_use_id);
		if (!onToolResult) continue;
		const text =
			typeof block.content === "string"
				? block.content
				: Array.isArray(block.content)
					? block.content.map(c => (c as { text?: string }).text ?? "").join("\n")
					: "";
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: block.tool_use_id,
			toolName: toolNamesById.get(block.tool_use_id) ?? "tool",
			content: [{ type: "text", text }],
			isError: Boolean(block.is_error),
			timestamp: Date.now(),
		};
		await onToolResult(result);
	}
}

// ponytail: token counts only, no calculateCost. Claude Code turns bill against
// the user's subscription, not per-token, so any cost we computed would be
// fiction. usage.cost stays zero.
function applyUsage(output: AssistantMessage, usage: Record<string, number> | undefined): void {
	if (!usage) return;
	output.usage.input = usage.input_tokens ?? 0;
	output.usage.output = usage.output_tokens ?? 0;
	output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
	output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}
