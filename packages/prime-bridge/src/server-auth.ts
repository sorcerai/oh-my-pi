import * as fs from "node:fs/promises";
import type { PrimeBridgeConfig } from "./config";

export function unauthorized(): Response {
	return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
}

export function forbidden(): Response {
	return new Response("Forbidden", { status: 403 });
}

/**
 * Authenticate a versioned bridge request against the current token file.
 *
 * A null response means that the request is authorized. The token file is
 * read for every request so rotation takes effect without a server restart.
 */
export async function authenticate(request: Request, config: PrimeBridgeConfig): Promise<Response | null> {
	const origin = request.headers.get("origin");
	if (origin !== null && origin.length > 0 && !config.allowedOrigins.includes(origin)) return forbidden();
	let currentToken: string;
	try {
		currentToken = (await fs.readFile(config.tokenFile, "utf8")).trim();
	} catch {
		return unauthorized();
	}
	if (currentToken.length === 0 || request.headers.get("authorization") !== `Bearer ${currentToken}`)
		return unauthorized();
	return null;
}
