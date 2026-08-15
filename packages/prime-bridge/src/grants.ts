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
	/**
	 * Authority axis, independent of session scope. A worker grant holding
	 * `"omp:supervise"` may call supervisor-only tools *within* its granted
	 * sessions; it is not an unscoped supervisor. Supervisors hold every
	 * capability implicitly.
	 */
	readonly capabilities: readonly string[];
}

/** Principal recorded for a legacy bare-token file, which carries full authority. */
export const LEGACY_PRINCIPAL = "legacy-bare-token" as const;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const DIGEST_PREFIX = "sha256:";

/**
 * The precise shape `ensureBridgeToken` minted for the historical bare-token
 * format: two lowercase UUIDs concatenated (72 chars of hex and dashes).
 * A legacy bare token is recognized by shape alone — any other non-JSON content
 * is corruption, not a credential, and must fail closed rather than silently
 * become a full-authority supervisor.
 */
const LEGACY_BARE_TOKEN_PATTERN =
	/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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

function parseCapabilities(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new BridgeGrantError("grant capabilities must be an array of strings");
	for (const capability of value) {
		if (typeof capability !== "string" || capability.length === 0)
			throw new BridgeGrantError("grant capabilities must be non-empty strings");
	}
	return [...(value as readonly string[])];
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
	return {
		principal,
		role,
		sessions: parseSessions(value.sessions),
		capabilities: parseCapabilities(value.capabilities),
	};
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
		// Not JSON. Only the precise legacy bare-token shape is a credential;
		// anything else — a truncated grant file, a crash write, hand-editing —
		// is corruption and authenticates nobody.
		if (LEGACY_BARE_TOKEN_PATTERN.test(trimmed)) {
			return new Map([
				[
					bridgeTokenDigest(trimmed),
					{ principal: LEGACY_PRINCIPAL, role: "supervisor", sessions: [], capabilities: [] },
				],
			]);
		}
		throw new BridgeGrantError("token file is neither a grant object nor a legacy bare token");
	}
	if (!isPlainObject(parsed)) {
		// Valid JSON but not a grant object (a quoted string, a number, an array).
		// That is not a credential and is never treated as one.
		throw new BridgeGrantError("token file must be a grant object");
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

/** The capability a principal must hold to call supervisor-only tools. */
export const OMP_SUPERVISE_CAPABILITY = "omp:supervise" as const;

/** Whether a grant holds one capability. Supervisors hold every capability. */
export function grantHasCapability(grant: BridgeGrant, capability: string): boolean {
	return grant.role === "supervisor" || grant.capabilities.includes(capability);
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

/**
 * Returns a copy with the single grant matching one display handle removed.
 *
 * `grant list` shows a truncated digest, so a handle is matched by prefix against
 * the full digest key. An ambiguous prefix is refused rather than guessed: picking
 * one of several matching grants would revoke an authority the operator did not
 * name. The last-supervisor guard applies here too.
 */
export function withoutBridgeGrantHandle(
	grants: ReadonlyMap<string, BridgeGrant>,
	handle: string,
): ReadonlyMap<string, BridgeGrant> {
	const normalized = handle.startsWith(DIGEST_PREFIX) ? handle : `${DIGEST_PREFIX}${handle}`;
	const matches = [...grants.keys()].filter(digest => digest.startsWith(normalized));
	if (matches.length === 0) throw new BridgeGrantError(`no grant matches handle ${handle}`);
	if (matches.length > 1)
		throw new BridgeGrantError(`handle ${handle} matches ${matches.length} grants; use a longer one`);
	const remaining = new Map([...grants].filter(([digest]) => digest !== matches[0]));
	if (![...remaining.values()].some(grant => grant.role === "supervisor"))
		throw new BridgeGrantError("refusing to revoke the last supervisor grant");
	return remaining;
}
