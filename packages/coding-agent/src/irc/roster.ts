import { DEFAULT_PEER_ROSTER_LIMIT, LIST_STATUS_ORDER } from "@oh-my-pi/pi-tui/tools/irc";
import type { AgentRegistry } from "../registry/agent-registry";
import { isCurrentSessionRosterRef } from "../registry/persisted-agents";

export interface IrcPeerRosterRow {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	activity?: string;
}

export interface IrcPeerRosterData {
	/** Live (running+idle) peer rows, bounded at DEFAULT_PEER_ROSTER_LIMIT. */
	peers: IrcPeerRosterRow[];
	/** Current-root parked refs, counted but never named. */
	parkedCount: number;
	/** Live rows dropped by the bound; the prompt reports them truthfully. */
	omittedCount: number;
}

export function collectIrcPeerRoster(
	registry: AgentRegistry,
	selfId: string,
	rootSessionFile?: string,
): IrcPeerRosterData {
	// Running before idle, then newest activity
	// first — so the cap keeps the newest relevant siblings, not an
	// insertion-order prefix.
	const live = registry
		.listVisibleTo(selfId)
		.sort(
			(a, b) =>
				(LIST_STATUS_ORDER[a.status] ?? 9) - (LIST_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
		);
	const limit = DEFAULT_PEER_ROSTER_LIMIT;
	const omittedCount = Math.max(0, live.length - limit);
	const peers = (omittedCount > 0 ? live.slice(0, limit) : live).map(peer => ({
		id: peer.id,
		displayName: peer.displayName,
		kind: peer.kind,
		status: peer.status,
		activity: peer.activity,
	}));
	let parkedCount = 0;
	for (const ref of registry.list()) {
		if (
			ref.id !== selfId &&
			ref.kind !== "advisor" &&
			ref.status === "parked" &&
			isCurrentSessionRosterRef(ref, rootSessionFile)
		) {
			parkedCount++;
		}
	}
	return { peers, parkedCount, omittedCount };
}
