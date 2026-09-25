import type { BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import { DEFAULT_PEER_ROSTER_LIMIT } from "@oh-my-pi/pi-tui/tools/irc";
import type { InternalWriteResult } from "../../internal-urls/types";
import { collectIrcPeerRoster } from "../../task/executor";
import type { ToolSession } from "../../tools";
import type { ExternalPeerProvider } from "./external-peer-provider";
import { primePeerAddress, primeProviderErrorText, sanitizeBridgeText } from "./peer-format";

type PeerBucket = "running" | "idle" | "parked";

const PRIME_RUNNING_STATUSES: Record<string, true> = { running: true, ready: true, active: true };

function primeStatusBucket(status: string): PeerBucket | undefined {
	if (PRIME_RUNNING_STATUSES[status] === true) return "running";
	if (status === "idle" || status === "parked") return status;
	return undefined;
}

function parseBucket(value: string | null): PeerBucket | undefined {
	if (value === null || value === "") return undefined;
	if (value === "running" || value === "idle" || value === "parked") return value;
	throw new Error(`Invalid agent:// status filter: ${value}. Use running, idle, or parked.`);
}

/**
 * Bare `read agent://` when a Prime provider is configured: the local live
 * roster (same ordering, bound, and parked-count-only policy as the subagent
 * prompt roster) plus Prime peers, sharing one DEFAULT_PEER_ROSTER_LIMIT bound.
 * `?status=running|idle|parked` narrows both; by default running+idle show.
 * A provider failure keeps the local rows and appends a sanitized error line.
 */
export async function renderPeerDirectory(
	session: ToolSession,
	provider: ExternalPeerProvider,
	statusFilter: string | null,
): Promise<string> {
	const status = parseBucket(statusFilter);
	const registry = session.agentRegistry;
	const senderId = session.getAgentId?.() ?? undefined;
	const roster =
		registry && senderId
			? collectIrcPeerRoster(registry, senderId, session.getSessionFile?.() ?? undefined)
			: { peers: [], parkedCount: 0, omittedCount: 0 };
	const localPeers = roster.peers.filter(peer => (status === undefined ? true : peer.status === status));

	const sections: string[] = [];
	const localLines = localPeers.map(
		peer =>
			`- \`${peer.id}\` — ${peer.displayName} (${peer.kind}, ${peer.status})${peer.activity ? `: ${peer.activity}` : ""}`,
	);
	if (roster.omittedCount > 0) localLines.push(`${roster.omittedCount} more live peer(s) omitted.`);
	if (roster.parkedCount > 0) localLines.push(`${roster.parkedCount} parked peer(s) omitted.`);
	sections.push(["Local peers:", ...(localLines.length > 0 ? localLines : ["- (none)"])].join("\n"));

	const rows: { address: string; peer: ExternalPeer; bucket: PeerBucket | undefined }[] = [];
	try {
		const seen = new Set<string>();
		for (const peer of await provider.list()) {
			const sessionId =
				typeof peer.activeSessionId === "string" && peer.activeSessionId.length > 0
					? peer.activeSessionId
					: peer.id;
			const address = primePeerAddress(sessionId);
			if (seen.has(address)) continue;
			seen.add(address);
			rows.push({ address, peer, bucket: primeStatusBucket(peer.status) });
		}
	} catch (error) {
		sections.push(primeProviderErrorText("list", error));
		return sections.join("\n\n");
	}

	const counts = { running: 0, idle: 0, parked: 0 };
	for (const row of rows) if (row.bucket) counts[row.bucket]++;
	const matching = rows.filter(row =>
		status === undefined ? row.bucket === "running" || row.bucket === "idle" : row.bucket === status,
	);
	const shown = matching.slice(0, Math.max(0, DEFAULT_PEER_ROSTER_LIMIT - localPeers.length));
	const truncated = matching.length - shown.length;
	const primeLines = shown.map(
		row =>
			`- \`${row.address}\` — ${sanitizeBridgeText(row.peer.displayName)} (prime, ${sanitizeBridgeText(row.peer.status)})`,
	);
	if (truncated > 0) primeLines.push(`${truncated} Prime peer(s) truncated by list limit.`);
	primeLines.push(`Prime roster: ${counts.running} running, ${counts.idle} idle, ${counts.parked} parked.`);
	sections.push(["Prime peers (write agent://prime~<id>):", ...primeLines].join("\n"));
	return sections.join("\n\n");
}

/** `write agent://prime~<id>`: deliver through the Prime bridge and surface its receipt. */
export async function sendPrimeMessage(
	session: ToolSession,
	to: string,
	target: string,
	content: string,
	replyTo: string | undefined,
): Promise<InternalWriteResult> {
	const senderId = session.getAgentId?.() ?? undefined;
	const provider = session.externalPeerProvider;
	if (!provider) throw new Error("Prime peer messaging is unavailable in this session.");
	let receipt: BridgeReceipt;
	try {
		receipt = await provider.send(target, content, replyTo);
	} catch (error) {
		return {
			text: primeProviderErrorText("send", error),
			details: { message: { op: "send", from: senderId, to, externalReceipts: [] } },
			isError: true,
		};
	}
	const status = sanitizeBridgeText(receipt.status);
	const lines = [`Prime ${status === "failed" ? "send failed" : `send ${status}`}: ${sanitizeBridgeText(to)}`];
	if (receipt.error) lines.push(sanitizeBridgeText(receipt.error));
	return {
		text: lines.join("\n"),
		details: { message: { op: "send", from: senderId, to, externalReceipts: [receipt] } },
		isError: receipt.status === "failed",
	};
}

/** A successful ACK commits delivery; on failure the claim is released and the failure rethrown. */
export async function ackPrimeClaim(provider: ExternalPeerProvider, claimToken: string): Promise<void> {
	let failure: unknown;
	try {
		if (await provider.ack(claimToken)) return;
		failure = new Error("Prime bridge wait claim acknowledgement failed");
	} catch (error) {
		failure = error;
	}
	await provider.release(claimToken).catch(() => false); // the claim lease is the final recovery path
	throw failure;
}
