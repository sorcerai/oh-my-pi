import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { buildJobResult, nothingToWaitForResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServices, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRegistry } from "../registry/agent-registry";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";
import { MAX_WAIT_TIMEOUT_MS } from "@oh-my-pi/prime-bridge-protocol";
import type { ExternalPeerProvider, ExternalPeerWaitClaim } from "../integrations/prime-bridge/external-peer-provider";
import { formatPrimeMessage, primeProviderErrorText } from "../integrations/prime-bridge/peer-format";
import { ackPrimeClaim } from "../integrations/prime-bridge/peers";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;

/** Outcome of one Prime bridge long-poll: a claimed message, an expiry (null), or a provider error. */
interface PrimeLegOutcome {
	claim: ExternalPeerWaitClaim | null;
	error?: unknown;
}

interface WaitMessaging {
	registry: AgentRegistry;
	senderId: string;
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
}

/** Interrupt aborts end the wait with a normal result; any other abort rejects. */
function abortedWait(signal: AbortSignal): AgentToolResult<CoordinationDetails> {
	if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
		return {
			content: [{ type: "text", text: "Wait interrupted by message." }],
			details: { op: "wait", jobs: [], interrupted: true },
			useless: true,
		};
	}
	throwIfAborted(signal);
	throw new Error("wait aborted");
}

/** A failed Prime leg never masks a local result; it rides along as a note. */
function withPrimeError(
	result: AgentToolResult<CoordinationDetails>,
	error: unknown,
): AgentToolResult<CoordinationDetails> {
	if (error === undefined) return result;
	return { ...result, content: [...result.content, { type: "text", text: primeProviderErrorText("wait", error) }] };
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next background result or peer message";
	readonly description: string;
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(waitDescription, { primePeers: session.externalPeerProvider !== undefined });
	}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		const manager = this.session.asyncJobManager;
		const ownerFilter = senderId ? { ownerId: senderId } : undefined;
		// The Prime leg participates in every block whenever a provider is
		// configured; the gate below and the race read this same value.
		const prime = this.session.externalPeerProvider;

		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
		if (this.session.settings.get("launch.enabled")) await listServices(this.session, signal);
		const deadline = Date.now() + WAIT_MAX_MS;
		for (;;) {
			const queued = takeQueuedMessage(messaging);
			if (queued && messaging) return messageResult(messaging.senderId, queued);
			const jobs = manager?.getRunningJobs(ownerFilter) ?? [];
			// An accepted completion whose delivery has not reached the transcript
			// yet (queued, parked on the yield queue, or skipped while an earlier
			// wait watched it) is exactly what this wait is for: return it now
			// instead of reporting nothing to wait for.
			const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
			if (manager && undelivered.length > 0) {
				return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
			}
			const serviceRunning = hasLiveOwnedService(this.session);
			const runningPeer =
				messaging?.registry.listVisibleTo(messaging.senderId).some(ref => messaging.registry.isRunning(ref)) ??
				false;
			if (jobs.length === 0 && !runningPeer && !serviceRunning && !prime) {
				return nothingToWaitForResult(this.session);
			}
			const result = await this.#blockUntilWake({
				jobs,
				manager,
				messaging,
				serviceRunning,
				runningPeer,
				prime,
				deadline,
				signal,
				onUpdate,
			});
			if (result) return result;
		}
	}

	/**
	 * Block on one snapshot of wake sources. Returns undefined when the last
	 * running peer stopped with nothing else to report: its accepted result may
	 * register or settle a job right after, so the caller re-evaluates.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		runningPeer: boolean;
		prime: ExternalPeerProvider | undefined;
		deadline: number;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails> | undefined> {
		const { jobs, manager, messaging, serviceRunning, runningPeer, prime, deadline, signal, onUpdate } = args;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = messaging ? new AbortController() : undefined;
		const busCancelled = new Error("wait settled");
		const busLeg: Promise<{ message: IrcMessage | null; error: Error | null }> | undefined =
			messaging && busAbort
				? IrcBus.global()
						.wait(
							messaging.senderId,
							{},
							0,
							busAbort.signal,
							// Liveness ends the block when the last running peer stops. Without a
							// running peer (only possible with a Prime leg) it would reject at once
							// and spin the re-evaluation loop.
							jobs.length === 0 && !serviceRunning && runningPeer ? { liveness: messaging } : undefined,
						)
						.then(
							message => ({ message, error: null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		// Prime leg: bridge long-polls are capped, so an expiry re-arms while other
		// wake sources remain; alone, it ends the wait as an ordinary expiry.
		const primeAbort = new AbortController();
		const primeCancelled = new Error("wait settled");
		const armPrime = (provider: ExternalPeerProvider): Promise<PrimeLegOutcome> =>
			provider
				.wait(undefined, Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(0, deadline - Date.now())), primeAbort.signal)
				.then(
					claim => ({ claim }),
					error => ({ claim: null, error: error === primeCancelled ? undefined : error }),
				);
		let primeLeg = prime ? armPrime(prime) : undefined;
		const otherWakeSources = jobs.length > 0 || serviceRunning || runningPeer;
		let claim: ExternalPeerWaitClaim | undefined;
		let claimSettled = false;
		let primeError: unknown;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, Math.max(0, deadline - Date.now()));
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		let wake: "job" | "message" | "service" | "timeout" | "abort" | "prime";
		const baseLegs = [
			...jobs.map(job => job.promise.then(() => "job" as const)),
			...(busLeg ? [busLeg.then(() => "message" as const)] : []),
			...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
			timeout.then(() => "timeout" as const),
			abort.promise.then(() => "abort" as const),
		];
		try {
			for (;;) {
				const leg = primeLeg;
				wake = await Promise.race([...baseLegs, ...(leg ? [leg.then(() => "prime" as const)] : [])]);
				if (wake !== "prime" || !leg || !prime) break;
				const outcome = await leg;
				if (outcome.claim) {
					claim = outcome.claim;
					break;
				}
				primeLeg = undefined;
				if (outcome.error !== undefined) primeError = outcome.error;
				else if (otherWakeSources && Date.now() < deadline) primeLeg = armPrime(prime);
				if (!otherWakeSources) break;
			}
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			serviceAbort.abort();
			primeAbort.abort(primeCancelled);
			signal?.removeEventListener("abort", onAbort);
			// A claim landing after the race settled belongs to nobody: hand it back.
			const pending = primeLeg;
			if (prime && pending) {
				void pending.then(outcome => {
					if (outcome.claim && outcome.claim.claimToken !== claim?.claimToken)
						void prime.release(outcome.claim.claimToken).catch(() => false);
				});
			}
		}
		const releaseClaim = async (): Promise<void> => {
			if (!prime || !claim || claimSettled) return;
			claimSettled = true;
			await prime.release(claim.claimToken).catch(() => false);
		};
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			if (busLeg && messaging) {
				const { message, error } = await busLeg;
				if (message) return messageResult(messaging.senderId, message); // finally releases a held claim
				if (error && !signal?.aborted && !claim) return undefined;
			}
			if (prime && claim) {
				claimSettled = true; // #deliverClaim owns release/ACK from here
				return await this.#deliverClaim(prime, claim, messaging?.senderId, signal);
			}
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				return abortedWait(signal);
			}
			if (manager && jobs.length > 0)
				return withPrimeError(buildJobResult(this.session, manager, "wait", jobs, []), primeError);
			if (wake === "prime") {
				return primeError !== undefined
					? {
							content: [{ type: "text", text: primeProviderErrorText("wait", primeError) }],
							details: { op: "wait", jobs: [], externalWaited: null },
							isError: true,
						}
					: {
							content: [{ type: "text", text: "No Prime peer message arrived before the bridge wait expired." }],
							details: { op: "wait", jobs: [], externalWaited: null },
							useless: true,
						};
			}
			return withPrimeError(
				{
					content: [
						{
							type: "text",
							text:
								wake === "service"
									? "A service finished. Read proc:// for its status and output."
									: "Wait limit reached; background work may still be running. Read proc:// for status.",
						},
					],
					details: { op: "wait", jobs: [] },
				},
				primeError,
			);
		} finally {
			manager?.unwatchJobs(watchedIds);
			await releaseClaim();
		}
	}

	/**
	 * Commit a claimed Prime message: render, then ACK. Before the ACK succeeds,
	 * any abort or failure releases the claim (ackPrimeClaim releases its own
	 * failures) and aborts reject like every other wait abort. After a
	 * successful ACK the delivery is committed and returned even if the caller
	 * aborted meanwhile — dropping it would lose the message.
	 */
	async #deliverClaim(
		provider: ExternalPeerProvider,
		claim: ExternalPeerWaitClaim,
		senderId: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const release = () => provider.release(claim.claimToken).catch(() => false);
		const failed = (error: unknown): AgentToolResult<CoordinationDetails> => ({
			content: [{ type: "text", text: primeProviderErrorText("wait", error) }],
			details: { op: "wait", jobs: [], externalWaited: null },
			isError: true,
		});
		if (signal?.aborted) {
			await release();
			return abortedWait(signal);
		}
		let text: string;
		try {
			text = formatPrimeMessage(claim.message);
		} catch (error) {
			await release();
			return signal?.aborted ? abortedWait(signal) : failed(error);
		}
		if (signal?.aborted) {
			await release();
			return abortedWait(signal);
		}
		try {
			await ackPrimeClaim(provider, claim.claimToken);
		} catch (error) {
			return signal?.aborted ? abortedWait(signal) : failed(error);
		}
		return {
			content: [{ type: "text", text }],
			details: { op: "wait", from: senderId, externalWaited: claim.message },
		};
	}
}
