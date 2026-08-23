import type { AuthStorage, OAuthAccessResolution } from "./auth-storage";

const INVALID_AUTH_REF_MESSAGE =
	"Invalid local auth reference: expected provider:<providerId> or oauth-credential:<providerId>:<positiveCredentialId>";

/** A local reference that delegates credential selection to the provider's normal auth policy. */
export interface ProviderLocalAuthRef {
	readonly kind: "provider";
	readonly providerId: string;
}

/** A local reference pinned to one durable OAuth credential row. */
export interface OAuthCredentialLocalAuthRef {
	readonly kind: "oauth-credential";
	readonly providerId: string;
	readonly credentialId: number;
}

/** Parsed local authentication reference. It contains identity only and never contains credential material. */
export type LocalAuthRef = ProviderLocalAuthRef | OAuthCredentialLocalAuthRef;

/** Minimum credential lookup surface needed to resolve local authentication references. */
export interface LocalAuthRefStorage {
	readonly getApiKey?: AuthStorage["getApiKey"];
	readonly getOAuthAccessByCredentialId?: AuthStorage["getOAuthAccessByCredentialId"];
}

/** Request-local context passed to the existing AuthStorage resolution paths. */
export interface LocalAuthRefResolutionOptions {
	readonly sessionId?: string;
	readonly signal?: AbortSignal;
	/** Force-refresh the selected credential without changing account affinity. */
	readonly forceRefresh?: boolean;
}

/**
 * Parse a local authentication reference and verify that it belongs to the expected provider.
 *
 * Provider identifiers remain opaque. OAuth credential identifiers must be canonical positive,
 * safe integers so that parsing cannot select a different durable row through numeric coercion.
 */
export function parseLocalAuthRef(authRef: string, expectedProviderId: string): LocalAuthRef {
	if (expectedProviderId.length === 0) {
		throw new Error("Expected provider must be a non-empty string");
	}

	let parsed: LocalAuthRef;
	const providerPrefix = "provider:";
	const oauthPrefix = "oauth-credential:";
	if (authRef.startsWith(providerPrefix)) {
		const providerId = authRef.slice(providerPrefix.length);
		if (providerId.length === 0) {
			throw new Error(INVALID_AUTH_REF_MESSAGE);
		}
		parsed = { kind: "provider", providerId };
	} else if (authRef.startsWith(oauthPrefix)) {
		const suffix = authRef.slice(oauthPrefix.length);
		const separator = suffix.lastIndexOf(":");
		const providerId = separator < 0 ? "" : suffix.slice(0, separator);
		const credentialIdText = separator < 0 ? "" : suffix.slice(separator + 1);
		if (providerId.length === 0 || !/^[1-9]\d*$/.test(credentialIdText)) {
			throw new Error(INVALID_AUTH_REF_MESSAGE);
		}
		const credentialId = Number(credentialIdText);
		if (!Number.isSafeInteger(credentialId)) {
			throw new Error(INVALID_AUTH_REF_MESSAGE);
		}
		parsed = { kind: "oauth-credential", providerId, credentialId };
	} else {
		throw new Error(INVALID_AUTH_REF_MESSAGE);
	}

	if (parsed.providerId !== expectedProviderId) {
		throw new Error("Local auth reference provider does not match the expected provider");
	}
	return parsed;
}

/**
 * Resolve a local authentication reference through the supplied {@link AuthStorage} instance.
 *
 * Provider references retain normal selection, rotation, and refresh behavior. OAuth references
 * resolve only their durable row, bypass provider-wide API-key selection, and never fall back to
 * a sibling credential. Errors omit tokens and provider-supplied failure details.
 */
export async function resolveLocalAuthRef(
	authStorage: LocalAuthRefStorage,
	authRef: string,
	expectedProviderId: string,
	options: LocalAuthRefResolutionOptions = {},
): Promise<string> {
	const parsed = parseLocalAuthRef(authRef, expectedProviderId);
	if (parsed.kind === "provider") {
		if (typeof authStorage.getApiKey !== "function") {
			throw new Error("No authentication credential is available for the expected provider");
		}
		let credential: string | undefined;
		try {
			credential = await authStorage.getApiKey(parsed.providerId, options.sessionId, {
				signal: options.signal,
				forceRefresh: options.forceRefresh,
			});
		} catch {
			throw new Error("Authentication credential could not be resolved for the expected provider");
		}
		if (!credential) {
			throw new Error("No authentication credential is available for the expected provider");
		}
		return credential;
	}

	if (typeof authStorage.getOAuthAccessByCredentialId !== "function") {
		throw new Error("OAuth credential was not found for the expected provider");
	}
	let resolution: OAuthAccessResolution | undefined;
	try {
		resolution = await authStorage.getOAuthAccessByCredentialId(parsed.providerId, parsed.credentialId, {
			signal: options.signal,
			forceRefresh: options.forceRefresh,
		});
	} catch {
		throw new Error("OAuth credential could not be resolved for the expected provider");
	}
	if (resolution === undefined) {
		throw new Error("OAuth credential was not found for the expected provider");
	}
	if (!resolution.ok) {
		throw new Error("OAuth credential could not be resolved for the expected provider");
	}
	if (resolution.accessToken.length === 0) {
		throw new Error("OAuth credential has no access token");
	}
	return resolution.accessToken;
}
