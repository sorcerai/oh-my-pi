import * as fs from "node:fs/promises";
import type { PrimeBridgeConfig } from "./config";
import { type BridgeGrant, parseBridgeGrants } from "./grants";

function unauthorized(): Response {
	return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
}

export function forbidden(): Response {
	return new Response("Forbidden", { status: 403 });
}

/**
 * An authenticated caller. Authority is resolved server-side from the token
 * file alone; nothing a caller puts in a request may widen it.
 */
export interface BridgePrincipal extends BridgeGrant {
	readonly token: string;
}

export type AuthenticationOutcome =
	| { readonly ok: true; readonly principal: BridgePrincipal }
	| { readonly ok: false; readonly response: Response };

/**
 * Authenticate a versioned bridge request against the current token file.
 *
 * The token file is read for every request so grant rotation takes effect
 * without a server restart. A malformed token file authenticates nobody
 * rather than degrading to a permissive default.
 */
export async function authenticate(request: Request, config: PrimeBridgeConfig): Promise<AuthenticationOutcome> {
	const origin = request.headers.get("origin");
	if (origin !== null && origin.length > 0 && !config.allowedOrigins.includes(origin))
		return { ok: false, response: forbidden() };
	let grants: ReadonlyMap<string, BridgeGrant>;
	try {
		grants = parseBridgeGrants(await fs.readFile(config.tokenFile, "utf8"));
	} catch {
		return { ok: false, response: unauthorized() };
	}
	const header = request.headers.get("authorization");
	const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
	const grant = presented.length === 0 ? undefined : grants.get(presented);
	if (grant === undefined) return { ok: false, response: unauthorized() };
	return { ok: true, principal: { ...grant, token: presented } };
}
