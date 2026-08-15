import { createHash } from "node:crypto";

/**
 * Bridge authority grants.
 *
 * The token file answers two questions that used to be one: who is calling, and
 * what may they do. A grant is resolved server-side from the presented token and
 * nothing else — no header, body, or path segment may widen it.
 *
 * Grants are keyed by a digest of the token, never by the token itself, so the
 * file grants authority without storing anything presentable as a credential.
 */

/** Supervisors administer the bridge. Workers act only inside sessions granted to them. */
export type BridgeRole = "supervisor" | "worker";

/** One caller's identity and authority, as recorded in the token file. */
export interface BridgeGrant {
	readonly principal: string;
	readonly role: BridgeRole;
	/** Sessions a worker may address. Ignored for supervisors, who reach every session. */
	readonly sessions: readonly string[];
}

/** Principal recorded for a legacy bare-token file, which carries full authority. */
export const LEGACY_PRINCIPAL = "legacy-bare-token" as const;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const DIGEST_PREFIX = "sha256:";

/** Stable, non-reversible lookup key for a bearer token. */
export function bridgeTokenDigest(token: string): string {
	return `${DIGEST_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Structural failure of the token file. Messages never include token or session values. */
export class BridgeGrantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BridgeGrantError";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function parseSessions(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new BridgeGrantError("grant sessions must be an array of strings");
	for (const session of value) {
		if (typeof session !== "string" || session.length === 0)
			throw new BridgeGrantError("grant sessions must be non-empty strings");
	}
	return [...(value as readonly string[])];
}

function parseGrant(value: unknown): BridgeGrant {
	if (!isPlainObject(value)) throw new BridgeGrantError("each grant must be a plain object");
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_KEYS.has(key)) throw new BridgeGrantError("grant contains a forbidden key");
	}
	const { principal, role } = value;
	if (typeof principal !== "string" || principal.length === 0)
		throw new BridgeGrantError("grant principal must be a non-empty string");
	if (role !== "supervisor" && role !== "worker")
		throw new BridgeGrantError('grant role must be "supervisor" or "worker"');
	return { principal, role, sessions: parseSessions(value.sessions) };
}

/**
 * Parse token-file contents into a token-to-grant map.
 *
 * A bare token (the historical format) parses as one full-authority supervisor so
 * an existing deployment keeps working untouched. Anything malformed throws rather
 * than degrading to a permissive default.
 */
export function parseBridgeGrants(contents: string): ReadonlyMap<string, BridgeGrant> {
	const trimmed = contents.trim();
	if (trimmed.length === 0) throw new BridgeGrantError("token file is empty");

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Not JSON, so this is the legacy bare-token format.
		return new Map([[bridgeTokenDigest(trimmed), { principal: LEGACY_PRINCIPAL, role: "supervisor", sessions: [] }]]);
	}
	if (!isPlainObject(parsed)) {
		// Valid JSON but not a grant object (a bare quoted string, a number). Treat the
		// raw text as a token rather than silently accepting an unintended shape.
		return new Map([[bridgeTokenDigest(trimmed), { principal: LEGACY_PRINCIPAL, role: "supervisor", sessions: [] }]]);
	}

	const grants = new Map<string, BridgeGrant>();
	for (const key of Object.keys(parsed)) {
		if (FORBIDDEN_KEYS.has(key)) throw new BridgeGrantError("token file contains a forbidden key");
		if (key.trim().length === 0) throw new BridgeGrantError("token file contains an empty token");
		// A digest key is used as-is. A raw-token key is from the pre-digest format:
		// hash it so it still authenticates, and the next write persists the digest,
		// retiring the stored credential.
		grants.set(key.startsWith(DIGEST_PREFIX) ? key : bridgeTokenDigest(key), parseGrant(parsed[key]));
	}
	if (grants.size === 0) throw new BridgeGrantError("token file grants no tokens");
	return grants;
}

/** Whether a grant may address one session. Supervisors reach every session. */
export function grantAllowsSession(grant: BridgeGrant, sessionId: string): boolean {
	return grant.role === "supervisor" || grant.sessions.includes(sessionId);
}

/**
 * Reject a grant file that defines no supervisor.
 *
 * Such a file cannot administer its own bridge, so it is almost certainly a
 * mistake rather than an intentional lockout.
 */
export function assertBridgeGrantsHaveSupervisor(grants: ReadonlyMap<string, BridgeGrant>): void {
	for (const grant of grants.values()) {
		if (grant.role === "supervisor") return;
	}
	throw new BridgeGrantError("token file defines no supervisor grant");
}

/** Serialize grants for the token file. Stable key order keeps diffs readable. */
export function serializeBridgeGrants(grants: ReadonlyMap<string, BridgeGrant>): string {
	const record: Record<string, BridgeGrant> = {};
	for (const digest of [...grants.keys()].sort()) {
		const grant = grants.get(digest);
		if (grant !== undefined) record[digest] = grant;
	}
	return `${JSON.stringify(record, null, 2)}\n`;
}

/** Returns a copy with one grant added or replaced. */
export function withBridgeGrant(
	grants: ReadonlyMap<string, BridgeGrant>,
	token: string,
	grant: BridgeGrant,
): ReadonlyMap<string, BridgeGrant> {
	return new Map([...grants, [bridgeTokenDigest(token), grant]]);
}

/**
 * Returns a copy with every grant for one principal removed.
 *
 * Refuses to remove the last supervisor: a token file with no supervisor cannot
 * advertise a working token, which would lock the operator out of their own bridge.
 */
export function withoutBridgePrincipal(
	grants: ReadonlyMap<string, BridgeGrant>,
	principal: string,
): ReadonlyMap<string, BridgeGrant> {
	const remaining = new Map([...grants].filter(([, grant]) => grant.principal !== principal));
	if (remaining.size === grants.size) throw new BridgeGrantError(`no grant exists for principal ${principal}`);
	if (![...remaining.values()].some(grant => grant.role === "supervisor"))
		throw new BridgeGrantError("refusing to revoke the last supervisor grant");
	return remaining;
}
