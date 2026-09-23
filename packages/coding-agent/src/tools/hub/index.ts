/**
 * Hub tool — the single agent-coordination surface: peer messaging over the
 * IrcBus, lifecycle control for async background jobs, and supervision of
 * project-scoped long-running processes (launch).
 *
 * Op families:
 * - messaging: `send` (with `to`), `inbox`, `list`, `wait` (with `from`);
 * - jobs: `wait` (bare or with `ids`), `cancel`, `jobs`;
 * - processes: `start`, `ps`, `logs`, `stop`, `restart`, `describe`, plus
 *   `send`/`wait` when they carry a process `name`.
 *
 * The unified `wait` blocks until the FIRST of: a matching peer message, a
 * watched job settling, the wait window elapsing, or a steering interrupt.
 * Job results always deliver themselves when they finish — `wait` exists for
 * when the agent has nothing else to do.
 */

import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { BridgeMessage, BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import { POLL_WAIT_LADDER_MS } from "../../async/job-manager";
import type { ExternalPeerProvider, ExternalPeerWaitClaim } from "../../integrations/prime-bridge";
import { IrcBus } from "../../irc/bus";

import hubDescription from "../../prompts/tools/hub.md" with { type: "text" };
import type { AgentRegistry } from "../../registry/agent-registry";
import type { ToolSession } from "..";

import {
	buildJobResult,
	executeCancel,
	executeJobsSnapshot,
	noMatchingJobsResult,
	nothingToWaitForResult,
	snapshotJobs,
	visibleJobs,
} from "./jobs";

import { executeLaunch } from "./launch";
import { type LaunchParams } from "@oh-my-pi/pi-tui/tools/hub";
import {
	drainPendingInbox,
	executeInbox,
	executeList,
	executeMessageWait,
	executeSend,
	type HubListParams,
	messageResult,
	normalizeIrcTimeoutMs,
	resolveHubListLimit,
} from "./messaging";
import {
	EXTERNAL_PEER_ID_PREFIX,
	externalTargetId,
	formatExternalInbox,
	formatExternalMessage,
	formatExternalPeers,
	normalizeExternalPeerId,
} from "./rendering";

import {
	type CoordinationDetails,
	DEFAULT_HUB_LIST_LIMIT,
	type HubDetails,
	type HubListStatus,
	MAX_HUB_LIST_LIMIT,
} from "@oh-my-pi/pi-tui/tools/hub";
import { hubErrorResult } from "./types";

export type { LaunchParams, LaunchToolDetails } from "@oh-my-pi/pi-tui/tools/hub";
export { isIrcEnabled } from "./messaging";
export * from "./types";

const hubSchema = type({
	op: type(
		"'send' | 'wait' | 'inbox' | 'list' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
	).describe("hub operation"),
	"to?": type("string").describe('send: recipient agent id or "all"'),
	"message?": type("string").describe("send: message body"),
	"replyTo?": type("string").describe("send: message id being answered"),
	"await?": type("boolean").describe('send: wait for the recipient\'s reply (invalid with to:"all")'),
	"from?": type("string").describe("wait: only accept a message from this agent id"),
	"ids?": type("string[]").describe("wait: job ids to watch (omit = all running jobs); cancel: job ids to kill"),
	"peek?": type("boolean").describe("inbox: list messages without consuming them"),
	"status?": type("'running' | 'idle' | 'parked'").describe("list: filter by status; omit for running+idle"),
	"limit?": type("number > 0").describe(
		`list: max peer rows; default ${DEFAULT_HUB_LIST_LIMIT}, max ${MAX_HUB_LIST_LIMIT}`,
	),
	"name?": type("string <= 48").describe("process ops: stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last omp client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every omp and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait with name: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait with name: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send with name: stdin text"),
	"enter?": type("boolean").describe("send with name: append Enter after text; default true"),
	"keys?": type("string[]").describe("send with name: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe(
		"send with name: process-tree signal",
	),
	"timeout?": type("number > 0").describe("logs/stop/wait with name: max seconds; default 30 (stop: 5)"),
});

type HubParams = typeof hubSchema.infer;

interface MessagingDeps {
	registry: AgentRegistry;
	senderId: string;
	settings: ToolSession["settings"];
	/** Caller session file: direct sends refresh this root's persisted roster before resolving the target. */
	sessionFileHint?: string | null;
}

const PROGRESS_INTERVAL_MS = 500;
const PRIME_RUNNING_STATUSES: Record<string, true> = { running: true, ready: true, active: true };

function primeStatusBucket(status: string): HubListStatus | undefined {
	if (PRIME_RUNNING_STATUSES[status] === true) return "running";
	if (status === "idle" || status === "parked") return status;
	return undefined;
}

/** Mutating process ops require exec approval; messaging, jobs, and inspection are read-only. */
function hubApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "exec";
	const op = params.op;
	switch (op) {
		case "wait":
		case "inbox":
		case "list":
		case "jobs":
		case "cancel":
		case "ps":
		case "logs":
		case "describe":
			return "read";
		case "send": {
			// Peer DMs are read-tier; writing to a process stdin is exec-tier.
			const name = "name" in params ? params.name : undefined;
			const to = "to" in params ? params.to : undefined;
			return typeof name === "string" && name.length > 0 && !to ? "exec" : "read";
		}
		default:
			// start / stop / restart and anything unrecognized.
			return "exec";
	}
}

export class HubTool implements AgentTool<typeof hubSchema, HubDetails> {
	readonly name = "hub";
	readonly approval = hubApproval;
	readonly label = "Hub";
	readonly summary = "Message peer agents, control background jobs, and supervise long-running processes";
	readonly description: string;
	readonly parameters = hubSchema;
	readonly strict = true;
	readonly interruptible = (params: Partial<HubParams>): boolean => {
		if (params.op === "wait") return true;
		return params.op === "logs" && params.follow === true;
	};
	readonly loadMode = "essential";

	readonly examples: readonly ToolExample<typeof hubSchema.infer>[] = [
		{
			caption: "List peers",
			call: { op: "list" },
		},
		{
			caption: "Inspect parked peer history",
			call: { op: "list", status: "parked" },
		},
		{
			caption: "Fire-and-forget DM — same send wakes idle/parked peers",
			call: {
				op: "send",
				to: "AuthLoader",
				message: "Still touching src/server/auth.ts? I need to add a 401 path.",
			},
		},
		{
			caption: "Round-trip when you cannot proceed without the answer",
			call: {
				op: "send",
				to: "Main",
				message: "JWT or session cookies for the auth flow?",
				await: true,
			},
		},
		{
			caption: "Completely blocked: wait for the first finished job or incoming message",
			call: { op: "wait" },
		},
		{
			caption: "Block until a specific peer answers",
			call: { op: "wait", from: "AuthLoader" },
		},
		{
			caption: "Kill a hung background job",
			call: { op: "cancel", ids: ["bash_a1b2c3"] },
		},
		{
			caption: "Snapshot every background job without waiting",
			call: { op: "jobs" },
		},
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Follow process output after a cursor",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
		{
			caption: "Drive a REPL/debugger over stdin",
			call: { op: "send", name: "debugger", text: "breakpoint set --name main" },
		},
		{
			caption: "Interrupt a process",
			call: { op: "send", name: "debugger", keys: ["CTRL_C"] },
		},
		{
			caption: "Block until a process is ready",
			call: { op: "wait", name: "web", for: "ready", timeout: 30 },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(hubDescription);
	}
	#external(): ExternalPeerProvider | undefined {
		return this.session.externalPeerProvider;
	}

	/** A successful ACK commits delivery; callers must not discard it for a later abort. */
	async #ackExternalClaim(provider: ExternalPeerProvider, claimToken: string): Promise<void> {
		let failure: unknown;
		try {
			if (await provider.ack(claimToken)) return;
			failure = new Error("Prime bridge wait claim acknowledgement failed");
		} catch (error) {
			failure = error;
		}
		try {
			await provider.release(claimToken);
		} catch {
			// The claim lease remains the final recovery path.
		}
		throw failure;
	}

	async #renderExternalClaim(
		provider: ExternalPeerProvider,
		claimToken: string,
		message: BridgeMessage,
	): Promise<string> {
		try {
			return formatExternalMessage(message);
		} catch (error) {
			await provider.release(claimToken).catch(() => undefined);
			throw error;
		}
	}

	#externalError(
		op: "list" | "send" | "inbox" | "wait",
		error: unknown,
		details: Partial<CoordinationDetails> = {},
	): AgentToolResult<HubDetails> {
		const rawMessage =
			error instanceof Error && error.message.trim().length > 0 ? error.message : "Unknown Prime bridge error";
		const message = sanitizeText(rawMessage)
			.replace(/[\r\n]+/g, " ")
			.trim();
		return hubErrorResult(`Prime external peer provider failed during ${op}: ${message}`, {
			op,
			...details,
		});
	}

	#withExternalError(
		local: AgentToolResult<HubDetails>,
		op: "list" | "inbox",
		error: unknown,
	): AgentToolResult<HubDetails> {
		const external = this.#externalError(op, error);
		const externalText = external.content.find(part => part.type === "text");
		if (!externalText) return { ...local, isError: true };

		let appended = false;
		const content = local.content.map(part => {
			if (part.type !== "text" || appended) return part;
			appended = true;
			return { ...part, text: `${part.text}\n\n${externalText.text}` };
		});
		if (!appended) content.push(externalText);
		return { ...local, content, isError: true };
	}

	async #executeExternalList(
		messaging: MessagingDeps | null,
		params: HubListParams = {},
	): Promise<AgentToolResult<HubDetails>> {
		const provider = this.#external();
		if (!provider) throw new Error("External provider is unavailable");
		const local = messaging
			? await executeList(messaging.registry, messaging.senderId, params, this.session.getSessionFile())
			: {
					content: [{ type: "text" as const, text: "No other agents." }],
					details: { op: "list" as const, from: undefined, peers: [] },
				};
		let rawPeers: ExternalPeer[];
		try {
			rawPeers = await provider.list();
		} catch (error) {
			return messaging ? this.#withExternalError(local, "list", error) : this.#externalError("list", error);
		}

		const localPeers = local.details?.peers ?? [];
		const localCounts = local.details?.counts ?? { running: 0, idle: 0, parked: 0, shown: 0, truncated: 0 };
		const limit = resolveHubListLimit(params.limit);
		const seen = new Set(localPeers.map(peer => peer.id));
		const filteredExternalPeers: ExternalPeer[] = [];
		let externalRunning = 0;
		let externalIdle = 0;
		let externalParked = 0;
		for (const peer of rawPeers) {
			const bucket = primeStatusBucket(peer.status);
			const activeSessionId =
				typeof peer.activeSessionId === "string" && peer.activeSessionId.length > 0
					? peer.activeSessionId
					: peer.id;
			let id: string;
			try {
				id = normalizeExternalPeerId(activeSessionId);
			} catch (error) {
				return messaging ? this.#withExternalError(local, "list", error) : this.#externalError("list", error);
			}
			if (seen.has(id)) continue;
			seen.add(id);
			if (bucket === "running") externalRunning++;
			else if (bucket === "idle") externalIdle++;
			else if (bucket === "parked") externalParked++;
			if (params.status !== undefined ? bucket !== params.status : bucket !== "running" && bucket !== "idle")
				continue;
			filteredExternalPeers.push({ ...peer, id });
		}
		const externalPeers = filteredExternalPeers.slice(0, Math.max(0, limit - localPeers.length));
		const externalTruncated = Math.max(0, filteredExternalPeers.length - externalPeers.length);
		const counts = {
			running: localCounts.running + externalRunning,
			idle: localCounts.idle + externalIdle,
			parked: localCounts.parked + externalParked,
			shown: localPeers.length + externalPeers.length,
			truncated: localCounts.truncated + externalTruncated,
		};
		const externalText =
			formatExternalPeers(externalPeers) +
			(externalTruncated > 0 ? `\n(${externalTruncated} Prime peer(s) truncated by list limit.)` : "");
		const localText = local.content.find(part => part.type === "text")?.text ?? "";
		return {
			...local,
			content: [{ type: "text", text: [localText, externalText].filter(Boolean).join("\n\n") }],
			details: { ...local.details, op: "list", counts, externalPeers },
		};
	}

	async #executeExternalSend(params: HubParams, signal?: AbortSignal): Promise<AgentToolResult<HubDetails>> {
		const provider = this.#external();
		const senderId = this.session.getAgentId?.() ?? undefined;
		const to = params.to?.trim() ?? "";
		const target = externalTargetId(to);
		const message = params.message?.trim() ?? "";
		if (!provider)
			return hubErrorResult("Prime external peer messaging is unavailable in this session.", {
				op: "send",
				from: senderId,
				to,
			});
		if (!target) return hubErrorResult("Prime external peer target is invalid.", { op: "send", from: senderId, to });
		if (!message) return hubErrorResult('`message` is required for op="send".', { op: "send", from: senderId, to });

		let receipt: BridgeReceipt;
		try {
			receipt = await provider.send(target, message, params.replyTo);
		} catch (error) {
			return this.#externalError("send", error, { op: "send", from: senderId, to, externalReceipts: [] });
		}
		const details: CoordinationDetails = { op: "send", from: senderId, to, externalReceipts: [receipt] };
		const status = sanitizeText(receipt.status)
			.replace(/[\r\n]+/g, " ")
			.trim();
		const lines = [`Prime ${status === "failed" ? "send failed" : `send ${status}`}: ${sanitizeText(to)}`];
		if (receipt.error)
			lines.push(
				sanitizeText(receipt.error)
					.replace(/[\r\n]+/g, " ")
					.trim(),
			);
		if (params.await && receipt.status !== "failed") {
			const timeoutMs = normalizeIrcTimeoutMs(this.session.settings.get("irc.timeoutMs"));
			try {
				const claim = await provider.wait(target, timeoutMs, signal);
				const waited = claim?.message ?? null;
				const formatted = claim
					? await this.#renderExternalClaim(provider, claim.claimToken, claim.message)
					: undefined;
				if (claim !== null) await this.#ackExternalClaim(provider, claim.claimToken);
				details.externalWaited = waited;
				lines.push(
					waited
						? `Reply from ${sanitizeText(normalizeExternalPeerId(waited.originSessionId))}:`
						: `No reply from ${sanitizeText(to)}.`,
				);
				if (formatted) lines.push(formatted);
			} catch (error) {
				if (signal?.aborted) throw error;
				return this.#externalError("wait", error, details);
			}
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
			isError: receipt.status === "failed",
		};
	}

	async #executeExternalInbox(messaging: MessagingDeps | null, peek: boolean): Promise<AgentToolResult<HubDetails>> {
		const provider = this.#external();
		if (!provider) throw new Error("External provider is unavailable");
		const local = messaging
			? executeInbox(messaging.registry, messaging.senderId, peek)
			: {
					content: [{ type: "text" as const, text: "Inbox empty." }],
					details: { op: "inbox" as const, from: undefined, inbox: [] },
				};
		let externalInbox: BridgeMessage[];
		try {
			externalInbox = await provider.inbox(peek);
		} catch (error) {
			return messaging
				? this.#withExternalError(local, "inbox", error)
				: this.#externalError("inbox", error, { op: "inbox", externalInbox: [] });
		}
		const seen = new Set<string>();
		const dedupedInbox: BridgeMessage[] = [];
		for (const message of externalInbox) {
			if (seen.has(message.meshMessageId)) continue;
			seen.add(message.meshMessageId);
			dedupedInbox.push(message);
		}
		const localText = local.content.find(part => part.type === "text")?.text ?? "";
		return {
			...local,
			content: [
				{ type: "text", text: [localText, formatExternalInbox(dedupedInbox, peek)].filter(Boolean).join("\n\n") },
			],
			details: { ...local.details, op: "inbox", externalInbox: dedupedInbox },
		};
	}
	async #executeExternalMessageWait(
		messaging: MessagingDeps | null,
		params: HubParams,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<HubDetails>> {
		const provider = this.#external();
		if (!provider) throw new Error("External provider is unavailable");
		const completedClaimTokens = new Set<string>();
		let winningClaimToken: string | undefined;
		const releaseClaim = async (claimToken: string): Promise<void> => {
			await provider.release(claimToken).catch(() => undefined);
			completedClaimTokens.add(claimToken);
		};
		const senderId = messaging?.senderId ?? this.session.getAgentId?.() ?? undefined;
		if (!senderId) return this.#externalError("wait", new Error("Agent identity is unavailable."), { op: "wait" });
		const from = params.from?.trim() || undefined;
		const externalRequested = from?.startsWith(EXTERNAL_PEER_ID_PREFIX) === true;
		const externalFrom = from === undefined ? undefined : externalTargetId(from);
		const localTarget =
			messaging && from !== undefined && !externalRequested
				? messaging.registry.listVisibleTo(messaging.senderId).some(peer => peer.id === from)
				: false;
		const localAbort = messaging && !externalRequested ? new AbortController() : undefined;
		const externalAbort = new AbortController();
		const cancelReason = new Error("hub wait settled");
		let removeAbortListener: (() => void) | undefined;
		if (signal) {
			const onAbort = (): void => {
				const reason = signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
				localAbort?.abort(reason);
				externalAbort.abort(reason);
			};
			if (signal.aborted) onAbort();
			else {
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}
		type WaitRaceResult =
			| { kind: "local"; result: AgentToolResult<HubDetails> }
			| { kind: "external"; claim: ExternalPeerWaitClaim | null }
			| { kind: "error"; error: unknown };
		const legs: Promise<WaitRaceResult | "timeout">[] = [];
		const localCanWait =
			messaging &&
			!externalRequested &&
			(from !== undefined ||
				messaging.registry.listVisibleTo(messaging.senderId).some(ref => ref.status === "running"));
		let localLeg: Promise<WaitRaceResult> | undefined;
		if (localCanWait && localAbort) {
			localLeg = executeMessageWait(messaging, { from, timeoutMs }, localAbort.signal).then(
				result => ({ kind: "local", result }),
				error => ({ kind: "error", error }),
			);
			legs.push(localLeg);
		}
		let externalLeg: Promise<WaitRaceResult> | undefined;
		if (!localTarget && (from === undefined || externalFrom !== undefined)) {
			externalLeg = provider.wait(externalFrom, timeoutMs, externalAbort.signal).then(
				claim => ({ kind: "external", claim }),
				error => ({ kind: "error", error }),
			);
			legs.push(externalLeg);
		}
		if (legs.length === 0) return nothingToWaitForResult(this.session);
		const timeoutPromise = Promise.withResolvers<void>();
		const timeoutHandle = timeoutMs > 0 ? setTimeout(() => timeoutPromise.resolve(), timeoutMs) : undefined;
		if (timeoutHandle) legs.push(timeoutPromise.promise.then(() => "timeout" as const));
		try {
			const winner = await Promise.race(legs);
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
			if (winner === "timeout") {
				return {
					content: [
						{
							type: "text",
							text: `No message${from ? ` from ${sanitizeText(from)}` : ""} within ${timeoutMs}ms.`,
						},
					],
					details: { op: "wait", from: senderId, waited: null, externalWaited: null },
					useless: true,
				};
			}
			if (winner.kind === "local") return winner.result;
			if (winner.kind === "external") {
				if (winner.claim) {
					winningClaimToken = winner.claim.claimToken;
					if (localLeg) {
						localAbort?.abort(cancelReason);
						const localWinner = await localLeg;
						if (localWinner.kind === "local") {
							await releaseClaim(winner.claim.claimToken);
							if (signal?.aborted)
								throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
							return localWinner.result;
						}
					}
					if (signal?.aborted) {
						await releaseClaim(winner.claim.claimToken);
						throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
					}
					let formatted: string;
					try {
						formatted = await this.#renderExternalClaim(provider, winner.claim.claimToken, winner.claim.message);
						if (signal?.aborted) {
							await releaseClaim(winner.claim.claimToken);
							throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
						}
						await this.#ackExternalClaim(provider, winner.claim.claimToken);
						completedClaimTokens.add(winner.claim.claimToken);
					} catch (error) {
						if (signal?.aborted) {
							if (!completedClaimTokens.has(winner.claim.claimToken))
								await releaseClaim(winner.claim.claimToken);
							throw error;
						}
						return this.#externalError("wait", error, { op: "wait", from: senderId });
					}
					return {
						content: [{ type: "text", text: formatted }],
						details: { op: "wait", from: senderId, externalWaited: winner.claim.message },
					};
				}
				if (localLeg) {
					const localWinner = await localLeg;
					if (localWinner.kind === "local") return localWinner.result;
					if (localWinner.kind === "error")
						return this.#externalError("wait", localWinner.error, { op: "wait", from: senderId });
				}
				return {
					content: [
						{
							type: "text",
							text: `No external Prime message${from ? ` from ${sanitizeText(from)}` : ""} within ${timeoutMs}ms.`,
						},
					],
					details: { op: "wait", from: senderId, externalWaited: null },
					useless: true,
				};
			}
			if (localLeg) {
				const localWinner = await localLeg;
				if (localWinner.kind === "local") return localWinner.result;
				if (localWinner.kind === "error")
					return this.#externalError("wait", localWinner.error, { op: "wait", from: senderId });
			}
			return this.#externalError("wait", winner.error, { op: "wait", from: senderId });
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			localAbort?.abort(cancelReason);
			externalAbort.abort(cancelReason);
			if (externalLeg) {
				void externalLeg.then(result => {
					if (
						result.kind === "external" &&
						result.claim &&
						result.claim.claimToken !== winningClaimToken &&
						!completedClaimTokens.has(result.claim.claimToken)
					)
						void provider.release(result.claim.claimToken).catch(() => undefined);
				});
			}
			removeAbortListener?.();
		}
	}

	/** Messaging deps when this session can address peers; null otherwise. */
	#messaging(): MessagingDeps | null {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry || !senderId) return null;
		return {
			registry,
			senderId,
			settings: this.session.settings,
			sessionFileHint: this.session.getSessionFile?.() ?? null,
		};
	}

	async execute(
		_toolCallId: string,
		params: HubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<HubDetails>> {
		switch (params.op) {
			case "list": {
				const messaging = this.#messaging();
				if (!messaging && !this.#external())
					return hubErrorResult("Peer messaging is unavailable in this session.", { op: "list" });
				return this.#external()
					? this.#executeExternalList(messaging, {
							status: params.status,
							limit: params.limit,
						})
					: executeList(
							messaging!.registry,
							messaging!.senderId,
							{
								status: params.status,
								limit: params.limit,
							},
							this.session.getSessionFile(),
						);
			}
			case "send": {
				const toPeer = params.to?.trim();
				const toProcess = params.name?.trim();
				if (toPeer && toProcess) {
					return hubErrorResult('`to` (peer) and `name` (process) are mutually exclusive for op="send".', {
						op: "send",
					});
				}
				if (toProcess) return this.#launch(params, "send", signal);
				const messaging = this.#messaging();
				if (toPeer?.startsWith(EXTERNAL_PEER_ID_PREFIX)) return this.#executeExternalSend(params, signal);
				const localPeer =
					toPeer && messaging
						? messaging.registry.listVisibleTo(messaging.senderId).some(peer => peer.id === toPeer)
						: false;
				if (localPeer) return executeSend(messaging!, params, signal);
				if (!messaging) return hubErrorResult("Peer messaging is unavailable in this session.", { op: "send" });
				return executeSend(messaging, params, signal);
			}
			case "inbox": {
				const messaging = this.#messaging();
				if (!messaging && !this.#external())
					return hubErrorResult("Peer messaging is unavailable in this session.", { op: "inbox" });
				return this.#external()
					? this.#executeExternalInbox(messaging, params.peek === true)
					: executeInbox(messaging!.registry, messaging!.senderId, params.peek);
			}
			case "wait":
				if (params.name?.trim()) return this.#launch(params, "wait", signal);
				return this.#executeWait(params, signal, onUpdate);
			case "cancel": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("cancel");
				if (!params.ids?.length) {
					return hubErrorResult('`ids` is required for op="cancel".', { op: "cancel", jobs: [] });
				}
				return await executeCancel(this.session, manager, this.#ownerId(), params.ids);
			}
			case "jobs": {
				const manager = this.session.asyncJobManager;
				if (!manager) return this.#asyncDisabled("jobs");
				return executeJobsSnapshot(this.session, manager, this.#ownerId());
			}
			case "start":
			case "ps":
			case "logs":
			case "stop":
			case "restart":
			case "describe":
				return this.#launch(params, params.op === "ps" ? "list" : params.op, signal);
			default:
				return hubErrorResult("Unknown hub op.", { op: params.op });
		}
	}

	/** Job visibility scope: everything the calling agent owns (tests/SDK without an agent id see all). */
	#ownerId(): string | undefined {
		return this.session.getAgentId?.() ?? undefined;
	}

	#asyncDisabled(op: "cancel" | "jobs"): AgentToolResult<HubDetails> {
		return {
			content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
			details: { op, jobs: [] },
		};
	}

	/** Route a process-supervision op to the launch broker, honoring `launch.enabled`. */
	async #launch(
		params: HubParams,
		op: LaunchParams["op"],
		signal?: AbortSignal,
	): Promise<AgentToolResult<HubDetails>> {
		if (!this.session.settings.get("launch.enabled")) {
			return hubErrorResult("Process supervision is disabled (launch.enabled=false).", { op: params.op });
		}
		const { op: _hubOp, ...rest } = params;
		return executeLaunch(this.session, { ...rest, op }, signal);
	}

	/**
	 * Unified wait: race the caller's running jobs against incoming peer
	 * messages. Returns on the FIRST settled job, the first matching message,
	 * window expiry, or abort — never "when everything finishes"; the model
	 * re-issues to keep waiting. With no job legs it degrades to a pure
	 * message wait; with no messaging it is exactly the old job poll.
	 */
	async #executeWait(
		params: HubParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<HubDetails>,
	): Promise<AgentToolResult<HubDetails>> {
		const messaging = this.#messaging();
		const provider = this.#external();
		const manager = this.session.asyncJobManager;
		const ownerId = this.#ownerId();
		const from = params.from?.trim() || undefined;
		const externalRequested = from?.startsWith(EXTERNAL_PEER_ID_PREFIX) === true;
		const externalFrom = from === undefined ? undefined : externalTargetId(from);
		if (externalRequested && externalFrom === undefined)
			return hubErrorResult("Prime external peer target is invalid.", { op: "wait", from: ownerId });
		if (externalRequested && provider === undefined)
			return hubErrorResult("Prime external peer messaging is unavailable in this session.", {
				op: "wait",
				from: ownerId,
			});
		const localTarget =
			messaging && from !== undefined && !externalRequested
				? messaging.registry.listVisibleTo(messaging.senderId).some(peer => peer.id === from)
				: false;

		// A message already buffered on the local session satisfies the wait next.
		if (messaging && !externalRequested) {
			const pending = drainPendingInbox(messaging.registry, messaging.senderId, from);
			if (pending) return messageResult(messaging.senderId, pending);
		}

		// Resolve which jobs to watch:
		// - explicit `ids` → exactly those (owner-scoped; missing ids corrected);
		// - omitted → every running job the caller owns.
		const ids = params.ids;
		const jobsToWatch = manager
			? ids?.length
				? visibleJobs(manager, ids, ownerId)
				: manager.getRunningJobs(ownerId ? { ownerId } : undefined)
			: [];
		if (manager && ids?.length && jobsToWatch.length === 0) {
			return noMatchingJobsResult(this.session, ids);
		}
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (manager && jobsToWatch.length > 0 && runningJobs.length === 0) {
			// Every explicitly watched job already settled — immediate snapshot.
			return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
		}

		// Wait window: the adaptive ladder starts at the floor and climbs as the
		// agent waits in a tight loop, then resets once it steps away (see
		// AsyncJobManager.nextPollWaitMs). Job and message waits share one
		// per-owner ladder; only paths that actually block advance and record it.
		const nextWindowMs = (): number => manager?.nextPollWaitMs(ownerId) ?? POLL_WAIT_LADDER_MS[0];

		if (!manager || runningJobs.length === 0) {
			// Drain buffered local messages before checking peer liveness or
			// blocking on the external bridge.
			if (messaging && !externalRequested) {
				const queued = IrcBus.global().take(messaging.senderId, from);
				if (queued) return messageResult(messaging.senderId, queued);
			}
			if (provider) {
				try {
					return await this.#executeExternalMessageWait(messaging, params, nextWindowMs(), signal);
				} finally {
					manager?.recordPollWaitEnd(ownerId);
				}
			}
			// No job legs: pure message wait — or nothing to block on at all.
			if (!messaging) return nothingToWaitForResult(this.session);
			if (!from) {
				// A bare wait can only be satisfied by a running peer eventually
				// sending something; with none, return the snapshot immediately
				// instead of blocking a full message-timeout window.
				const hasRunningPeer = messaging.registry
					.listVisibleTo(messaging.senderId)
					.some(ref => messaging.registry.isRunning(ref));
				if (!hasRunningPeer) return nothingToWaitForResult(this.session);
			}
			try {
				return await executeMessageWait(messaging, { from, timeoutMs: nextWindowMs() }, signal);
			} finally {
				manager?.recordPollWaitEnd(ownerId);
			}
		}

		const windowMs = nextWindowMs();
		let racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);

		// Message leg: park a bus waiter with no timeout of its own — the race
		// window governs. Cancelled via sentinel so late losers do not reject.
		const busAbort = messaging && !externalRequested ? new AbortController() : undefined;
		const busCancelled = new Error("hub wait settled");
		let removeBusAbortListener: (() => void) | undefined;
		const busLeg =
			messaging && busAbort
				? IrcBus.global()
						.wait(messaging.senderId, { from }, 0, busAbort.signal)
						.then(
							message => ({ message, error: null as Error | null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		if (busLeg) racePromises.push(busLeg);
		if (busAbort && signal) {
			if (signal.aborted) {
				busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
			} else {
				const onAbort = (): void => {
					busAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeBusAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}
		const externalAbort =
			provider && !localTarget && (from === undefined || externalFrom !== undefined)
				? new AbortController()
				: undefined;
		const externalCancelled = new Error("hub wait settled");
		let removeExternalAbortListener: (() => void) | undefined;
		const completedClaimTokens = new Set<string>();
		let winningClaimToken: string | undefined;
		const externalLeg =
			provider && externalAbort
				? provider.wait(externalFrom, windowMs, externalAbort.signal).then(
						claim => ({ external: true as const, claim, error: null as Error | null }),
						error => ({
							external: true as const,
							claim: null,
							error:
								error === externalCancelled ? null : error instanceof Error ? error : new Error(String(error)),
						}),
					)
				: undefined;
		if (externalLeg) racePromises.push(externalLeg);
		if (externalAbort && signal) {
			if (signal.aborted) {
				externalAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
			} else {
				const onAbort = (): void => {
					externalAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeExternalAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}

		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), windowMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const emitProgress = () => {
			if (!onUpdate) return;
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobsToWatch) },
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		let raceWinner: unknown;
		let removeRaceAbortListener: (() => void) | undefined;
		if (signal) {
			const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
			const onAbort = () => abortResolve();
			if (signal.aborted) onAbort();
			else {
				signal.addEventListener("abort", onAbort, { once: true });
				removeRaceAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
			racePromises.push(abortPromise);
		}
		try {
			while (true) {
				raceWinner = await Promise.race(racePromises);
				if (signal?.aborted) break;
				if (externalLeg && typeof raceWinner === "object" && raceWinner !== null && "external" in raceWinner) {
					const externalResult = raceWinner as {
						external: true;
						claim: ExternalPeerWaitClaim | null;
						error: Error | null;
					};
					if (externalResult.error || !externalResult.claim) {
						racePromises = racePromises.filter(promise => promise !== externalLeg);
						continue;
					}
					winningClaimToken = externalResult.claim.claimToken;
				}
				break;
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			clearTimeout(timeoutHandle);
			clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			externalAbort?.abort(externalCancelled);
			if (externalLeg) {
				void externalLeg.then(result => {
					if (
						provider !== undefined &&
						result.external &&
						result.claim &&
						result.claim.claimToken !== winningClaimToken &&
						!completedClaimTokens.has(result.claim.claimToken)
					)
						void provider.release(result.claim.claimToken).catch(() => undefined);
				});
			}
			removeBusAbortListener?.();
			removeExternalAbortListener?.();
			removeRaceAbortListener?.();
			// Reset the idle-gap clock: escalate if the agent waits again soon,
			// drop back to the floor once it goes quiet for a while.
			manager.recordPollWaitEnd(ownerId);
		}

		if (signal?.aborted) {
			if (provider && winningClaimToken) {
				await provider.release(winningClaimToken).catch(() => undefined);
				completedClaimTokens.add(winningClaimToken);
			}
			throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
		}
		if (externalLeg && typeof raceWinner === "object" && raceWinner !== null && "external" in raceWinner) {
			const externalResult = raceWinner as {
				external: true;
				claim: ExternalPeerWaitClaim | null;
				error: Error | null;
			};
			if (externalResult.claim) {
				if (provider === undefined)
					return this.#externalError("wait", new Error("External provider is unavailable"), {
						op: "wait",
						from: ownerId,
					});
				if (busLeg && messaging) {
					const settled = await busLeg;
					if (settled.message) {
						await provider.release(externalResult.claim.claimToken).catch(() => undefined);
						completedClaimTokens.add(externalResult.claim.claimToken);
						if (signal?.aborted)
							throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
						return messageResult(messaging.senderId, settled.message);
					}
				}
				if (signal?.aborted) {
					await provider.release(externalResult.claim.claimToken).catch(() => undefined);
					completedClaimTokens.add(externalResult.claim.claimToken);
					throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
				}
				try {
					const formatted = await this.#renderExternalClaim(
						provider,
						externalResult.claim.claimToken,
						externalResult.claim.message,
					);
					if (signal?.aborted) {
						await provider.release(externalResult.claim.claimToken).catch(() => undefined);
						completedClaimTokens.add(externalResult.claim.claimToken);
						throw signal.reason instanceof Error ? signal.reason : new Error("hub wait aborted");
					}
					await this.#ackExternalClaim(provider, externalResult.claim.claimToken);
					completedClaimTokens.add(externalResult.claim.claimToken);
					return {
						content: [{ type: "text", text: formatted }],
						details: { op: "wait", from: ownerId, externalWaited: externalResult.claim.message },
					};
				} catch (error) {
					if (signal?.aborted) {
						if (!completedClaimTokens.has(externalResult.claim.claimToken)) {
							await provider.release(externalResult.claim.claimToken).catch(() => undefined);
							completedClaimTokens.add(externalResult.claim.claimToken);
						}
						throw error;
					}
					return this.#externalError("wait", error, { op: "wait", from: ownerId });
				}
			}
		}
		// A message consumed by the bus waiter must never be dropped — it wins
		// even a photo-finish race (job results re-deliver themselves; a
		// dequeued message would otherwise be lost).
		if (busLeg && messaging) {
			const settled = await busLeg;
			if (settled.message) return messageResult(messaging.senderId, settled.message);
		}

		return buildJobResult(this.session, manager, "wait", jobsToWatch, []);
	}
}
