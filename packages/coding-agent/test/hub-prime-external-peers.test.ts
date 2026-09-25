import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { BridgeMessage, BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import type { ExternalPeerProvider, ExternalPeerWaitClaim } from "../src/integrations/prime-bridge";

function bridgeMessage(overrides: Partial<BridgeMessage> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-1",
		idempotencyKey: "idem-1",
		originHarness: "prime",
		originSessionId: "prime-session",
		targetHarness: "omp",
		targetId: "omp-session",
		body: "hello",
		projectRoot: "/repo",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function waitClaim(message: BridgeMessage, claimToken = "claim-1"): ExternalPeerWaitClaim {
	return { message, claimToken, claimedUntilMs: Date.now() + 30_000 };
}

interface Calls {
	acks: string[];
	releases: string[];
}

function calls(): Calls {
	return { acks: [], releases: [] };
}

function provider(overrides: Partial<ExternalPeerProvider> = {}, seen?: Calls): ExternalPeerProvider {
	return {
		list: async () => [],
		send: async () => ({ meshMessageId: "receipt-1", status: "queued" }),
		wait: async () => null,
		ack: async token => {
			seen?.acks.push(token);
			return true;
		},
		release: async token => {
			seen?.releases.push(token);
			return true;
		},
		...overrides,
	};
}

function session(externalPeerProvider?: ExternalPeerProvider, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		// Keep the machine-global launch broker out of wait's pre-block service scan.
		settings: Settings.isolated({ "launch.enabled": false }),
		agentRegistry: AgentRegistry.global(),
		getAgentId: () => MAIN_AGENT_ID,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		externalPeerProvider,
		...overrides,
	} as unknown as ToolSession;
}

function registerPeer(id: string, status: "running" | "idle", inbox?: IrcMessage[]): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		status,
		session: {
			isStreaming: status === "running",
			deliverIrcMessage: async (message: IrcMessage) => {
				inbox?.push(message);
				return status === "idle" ? "woken" : "injected";
			},
		} as unknown as AgentSession,
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Bun.sleep(0);
}

function pendingJob(manager: AsyncJobManager): string {
	return manager.register("bash", "wait forever", async () => Promise.withResolvers<string>().promise, {
		ownerId: MAIN_AGENT_ID,
	});
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: MAIN_AGENT_ID,
		kind: "main",
		session: null,
		status: "running",
	});
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("write agent://prime~<id>", () => {
	it("decodes the Prime address, forwards replyTo, and returns the verbatim receipt", async () => {
		const sent: Array<[string, string, string | undefined]> = [];
		const receipt: BridgeReceipt = { meshMessageId: "receipt-1", status: "queued", extra: { keep: true } };
		const result = await new WriteTool(
			session(
				provider({
					send: async (target, message, replyTo) => {
						sent.push([target, message, replyTo]);
						return receipt;
					},
				}),
			),
		).execute("send", { path: "agent://prime~session%2F1?replyTo=mesh-9", content: "hello\nthere" });
		expect(sent).toEqual([["session/1", "hello\nthere", "mesh-9"]]);
		expect(result.details?.message?.externalReceipts).toEqual([receipt]);
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toContain("Prime send queued");
	});

	it("routes numeric and selector-like Prime ids instead of peeling them as selectors", async () => {
		const targets: string[] = [];
		await new WriteTool(
			session(
				provider({
					send: async target => {
						targets.push(target);
						return { meshMessageId: "r", status: "delivered" };
					},
				}),
			),
		).execute("send", { path: "agent://prime~123", content: "hi" });
		await new WriteTool(
			session(
				provider({
					send: async target => {
						targets.push(target);
						return { meshMessageId: "r", status: "delivered" };
					},
				}),
			),
		).execute("send", { path: "agent://prime~a%3Araw", content: "hi" });
		expect(targets).toEqual(["123", "a:raw"]);
	});

	it("surfaces a failed receipt and a provider rejection as sanitized tool errors", async () => {
		const failed = await new WriteTool(
			session(provider({ send: async () => ({ meshMessageId: "r", status: "failed", error: "no\nsuch peer" }) })),
		).execute("send", { path: "agent://prime~gone", content: "hi" });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toContain("no such peer");

		const rejected = await new WriteTool(
			session(
				provider({
					send: async () => {
						throw new Error("bridge down\r\nretry\u0000\u001b[31m");
					},
				}),
			),
		).execute("send", { path: "agent://prime~x", content: "hi" });
		expect(rejected.isError).toBe(true);
		expect(textOf(rejected)).toContain("Prime external peer provider failed during send: bridge down retry");
		expect(textOf(rejected)).not.toContain("\u0000");
		expect(textOf(rejected)).not.toContain("\u001b");
	});

	it("rejects a Prime address when no provider is configured", async () => {
		await expect(
			new WriteTool(session()).execute("send", { path: "agent://prime~x", content: "hi" }),
		).rejects.toThrow("Prime peer messaging is unavailable");
	});

	it("keeps local agent:// delivery on the local bus when a provider is configured", async () => {
		const inbox: IrcMessage[] = [];
		registerPeer("Scout", "running", inbox);
		let primeSends = 0;
		const result = await new WriteTool(
			session(
				provider({
					send: async () => {
						primeSends++;
						return { meshMessageId: "r", status: "queued" };
					},
				}),
			),
		).execute("send", { path: "agent://Scout", content: "local" });
		expect(textOf(result)).toBe("Delivered to Scout.");
		expect(inbox.map(message => message.body)).toEqual(["local"]);
		expect(primeSends).toBe(0);
	});
});

describe("read agent:// peer directory", () => {
	async function directory(p?: ExternalPeerProvider, query = ""): Promise<string> {
		return textOf(await new ReadTool(session(p)).execute("read", { path: `agent://${query}` }));
	}

	it("merges deduplicated Prime peers under their agent:// addresses beside local rows", async () => {
		registerPeer("LocalIdle", "idle");
		const peers: ExternalPeer[] = [
			{ id: "prime-id", displayName: "Prime worker", status: "ready", activeSessionId: "session/1" },
			{ id: "prime-id-dup", displayName: "Same session", status: "ready", activeSessionId: "session/1" },
		];
		const text = await directory(provider({ list: async () => peers }));
		expect(text).toContain("`LocalIdle`");
		expect(text).toContain("`prime~session%2F1` — Prime worker (prime, ready)");
		expect(text).not.toContain("Same session");
	});

	it("hides parked Prime peers by default, lists them by status, and always reports full counts", async () => {
		const list = async (): Promise<ExternalPeer[]> => [
			{ id: "running", displayName: "Running", status: "ready" },
			{ id: "idle", displayName: "Idle", status: "idle" },
			{ id: "parked", displayName: "Parked", status: "parked" },
			{ id: "unknown", displayName: "Unknown", status: "unknown" },
		];
		const active = await directory(provider({ list }));
		expect(active).toContain("`prime~running`");
		expect(active).toContain("`prime~idle`");
		expect(active).not.toContain("`prime~parked`");
		expect(active).not.toContain("`prime~unknown`");
		expect(active).toContain("Prime roster: 1 running, 1 idle, 1 parked.");

		const parked = await directory(provider({ list }), "?status=parked");
		expect(parked).toContain("`prime~parked`");
		expect(parked).not.toContain("`prime~running`");
		expect(parked).toContain("Prime roster: 1 running, 1 idle, 1 parked.");
	});

	it("applies one roster bound across local and Prime rows and reports the truncation", async () => {
		registerPeer("LocalRunning", "running");
		const list = async (): Promise<ExternalPeer[]> =>
			Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, displayName: `P${i}`, status: "ready" }));
		const text = await directory(provider({ list }));
		expect(text).toContain("`LocalRunning`");
		expect(text).toContain("`prime~p30`");
		expect(text).not.toContain("`prime~p31`");
		expect(text).toContain("2 Prime peer(s) truncated by list limit.");
	});

	it("keeps local rows and appends a sanitized error when the provider fails", async () => {
		registerPeer("Peer", "running");
		const rejected = await directory(
			provider({
				list: async () => {
					throw new Error("provider unavailable\nretry later\u0000\u001b[31m");
				},
			}),
		);
		expect(rejected).toContain("`Peer`");
		expect(rejected).toContain("Prime external peer provider failed during list: provider unavailable retry later");
		expect(rejected).not.toContain("\u0000");
		expect(rejected).not.toContain("\u001b");

		const malformed = await directory(
			provider({ list: async () => [{ id: "\ud800", displayName: "Malformed", status: "ready" }] }),
		);
		expect(malformed).toContain("`Peer`");
		expect(malformed).toContain("well-formed Unicode");
	});

	it("keeps upstream's bare agent:// error when no provider is configured", async () => {
		await expect(new ReadTool(session()).execute("read", { path: "agent://" })).rejects.toThrow(
			"requires an output ID",
		);
	});
});

describe("wait Prime leg", () => {
	it("returns and acknowledges a Prime message when Prime is the only wake source", async () => {
		const seen = calls();
		const external = bridgeMessage({ body: "external winner" });
		const result = await new WaitTool(session(provider({ wait: async () => waitClaim(external) }, seen))).execute(
			"wait",
			{},
		);
		expect(result.details?.externalWaited).toEqual(external);
		expect(textOf(result)).toBe("[mesh-1] prime~prime-session: external winner");
		expect(seen).toEqual({ acks: ["claim-1"], releases: [] });
	});

	it("reports nothing to wait for without a provider, and a single bridge expiry with one", async () => {
		const bare = await new WaitTool(session()).execute("wait", {});
		expect(bare.useless).toBe(true);
		expect(bare.details?.externalWaited).toBeUndefined();

		let waits = 0;
		const expired = await new WaitTool(
			session(
				provider({
					wait: async () => {
						waits++;
						return null;
					},
				}),
			),
		).execute("wait", {});
		expect(waits).toBe(1);
		expect(expired.useless).toBe(true);
		expect(expired.details?.externalWaited).toBeNull();
	});

	it.each([false, true])(
		"keeps an ACKed delivery when cancellation lands during ACK (watched job: %s)",
		async withJob => {
			const controller = new AbortController();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const jobId = withJob ? pendingJob(manager) : undefined;
			const seen = calls();
			const external = bridgeMessage({ body: "committed delivery" });
			try {
				const result = await new WaitTool(
					session(
						provider(
							{
								wait: async () => waitClaim(external),
								ack: async () => {
									controller.abort();
									return true;
								},
							},
							seen,
						),
						{ asyncJobManager: manager },
					),
				).execute("wait", {}, controller.signal);
				expect(result.details?.externalWaited).toEqual(external);
				expect(seen.releases).toEqual([]);
			} finally {
				if (jobId) manager.cancel(jobId);
			}
		},
	);

	it.each([false, true])(
		"releases the claim and rejects when the caller aborts before ACK (watched job: %s)",
		async withJob => {
			const controller = new AbortController();
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const jobId = withJob ? pendingJob(manager) : undefined;
			const seen = calls();
			const external = bridgeMessage();
			Object.defineProperty(external, "body", {
				get() {
					controller.abort(new Error("aborted while rendering"));
					return "external message";
				},
			});
			try {
				await expect(
					new WaitTool(
						session(provider({ wait: async () => waitClaim(external) }, seen), { asyncJobManager: manager }),
					).execute("wait", {}, controller.signal),
				).rejects.toBeInstanceOf(ToolAbortError);
				expect(seen).toEqual({ acks: [], releases: ["claim-1"] });
			} finally {
				if (jobId) manager.cancel(jobId);
			}
		},
	);

	it("releases a claim and ends with the interrupt result when steering interrupts before ACK", async () => {
		const controller = new AbortController();
		const seen = calls();
		const external = bridgeMessage();
		Object.defineProperty(external, "body", {
			get() {
				controller.abort(TOOL_INTERRUPT_ABORT_REASON);
				return "external message";
			},
		});
		const result = await new WaitTool(session(provider({ wait: async () => waitClaim(external) }, seen))).execute(
			"wait",
			{},
			controller.signal,
		);
		expect(result.details?.interrupted).toBe(true);
		expect(seen).toEqual({ acks: [], releases: ["claim-1"] });
	});

	it.each([false, true])(
		"a locally consumed message wins the photo finish and the Prime claim is released (watched job: %s)",
		async withJob => {
			registerPeer("Peer", "running");
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const jobId = withJob ? pendingJob(manager) : undefined;
			const seen = calls();
			try {
				const result = await new WaitTool(
					session(
						provider(
							{
								// The local message lands in the parked bus waiter before the
								// claim resolves, so both legs settle together.
								wait: async () => {
									await IrcBus.global().send({ from: "Peer", to: MAIN_AGENT_ID, body: "local winner" });
									return waitClaim(bridgeMessage({ body: "external loser" }));
								},
							},
							seen,
						),
						{ asyncJobManager: manager },
					),
				).execute("wait", {});
				await flush();
				expect(result.details?.waited?.body).toBe("local winner");
				expect(result.details?.externalWaited).toBeUndefined();
				expect(seen).toEqual({ acks: [], releases: ["claim-1"] });
			} finally {
				if (jobId) manager.cancel(jobId);
			}
		},
	);

	it.each([0, 1, 2, 3, 4, 5, 6, 8])(
		"never loses either message when a local send and a Prime claim race (%d microtask offset)",
		async offset => {
			registerPeer("Peer", "running");
			// A message the wait did not consume must still reach the session.
			const sessionInbox: IrcMessage[] = [];
			AgentRegistry.global().register({
				id: MAIN_AGENT_ID,
				displayName: MAIN_AGENT_ID,
				kind: "main",
				status: "running",
				session: {
					deliverIrcMessage: async (message: IrcMessage) => {
						sessionInbox.push(message);
						return "injected";
					},
				} as unknown as AgentSession,
			});
			const seen = calls();
			const result = await new WaitTool(
				session(
					provider(
						{
							wait: async () => {
								void (async () => {
									for (let i = 0; i < offset; i++) await Promise.resolve();
									await IrcBus.global().send({ from: "Peer", to: MAIN_AGENT_ID, body: "local" });
								})();
								return waitClaim(bridgeMessage({ body: "prime" }));
							},
						},
						seen,
					),
				),
			).execute("wait", {});
			await flush();
			if (result.details?.waited) {
				expect(result.details.waited.body).toBe("local");
				expect(seen).toEqual({ acks: [], releases: ["claim-1"] });
			} else {
				expect(result.details?.externalWaited?.body).toBe("prime");
				expect(seen).toEqual({ acks: ["claim-1"], releases: [] });
				expect(sessionInbox.map(message => message.body)).toEqual(["local"]);
			}
		},
	);

	it("releases a claim that lands after a job already won the race", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = Promise.withResolvers<string>();
		manager.register("bash", "build", async () => job.promise, { ownerId: MAIN_AGENT_ID });
		const claim = Promise.withResolvers<ExternalPeerWaitClaim | null>();
		const armed = Promise.withResolvers<void>();
		const seen = calls();
		const waiting = new WaitTool(
			session(
				provider(
					{
						wait: async () => {
							armed.resolve();
							return claim.promise;
						},
					},
					seen,
				),
				{ asyncJobManager: manager },
			),
		).execute("wait", {});
		await armed.promise;
		job.resolve("build done");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ status: "completed" });
		claim.resolve(waitClaim(bridgeMessage(), "late-claim"));
		await flush();
		expect(seen).toEqual({ acks: [], releases: ["late-claim"] });
	});

	it("surfaces an ACK failure as a tool error and releases the claim", async () => {
		const seen = calls();
		const result = await new WaitTool(
			session(provider({ wait: async () => waitClaim(bridgeMessage()), ack: async () => false }, seen)),
		).execute("wait", {});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Prime bridge wait claim acknowledgement failed");
		expect(result.details?.externalWaited).toBeNull();
		expect(seen.releases).toEqual(["claim-1"]);
	});

	it("surfaces a provider error without breaking a local job leg", async () => {
		let armed = Promise.withResolvers<void>();
		const failing = provider({
			wait: async () => {
				armed.resolve();
				throw new Error("bridge offline\nnow");
			},
		});
		const alone = await new WaitTool(session(failing)).execute("wait", {});
		expect(alone.isError).toBe(true);
		expect(textOf(alone)).toContain("Prime external peer provider failed during wait: bridge offline now");

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = Promise.withResolvers<string>();
		manager.register("bash", "build", async () => job.promise, { ownerId: MAIN_AGENT_ID });
		armed = Promise.withResolvers<void>();
		const waiting = new WaitTool(session(failing, { asyncJobManager: manager })).execute("wait", {});
		await armed.promise;
		await flush();
		job.resolve("build done");
		const withJob = await waiting;
		expect(withJob.isError).toBeFalsy();
		expect(withJob.details?.jobs?.[0]).toMatchObject({ status: "completed", resultText: "build done" });
		expect(textOf(withJob)).toContain("Prime external peer provider failed during wait: bridge offline now");
	});
});
