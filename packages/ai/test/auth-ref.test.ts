import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	parseLocalAuthRef,
	resolveLocalAuthRef,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai";

const PROVIDER = "unit-auth-ref";

class MemoryAuthCredentialStore implements AuthCredentialStore {
	#rows: StoredAuthCredential[] = [];
	#nextId = 1;

	close(): void {}

	listAuthCredentials(provider?: string): StoredAuthCredential[] {
		return this.#rows.filter(row => row.disabledCause === null && (!provider || row.provider === provider));
	}

	updateAuthCredential(id: number, credential: AuthCredential): void {
		const row = this.#rows.find(candidate => candidate.id === id);
		if (row) row.credential = credential;
	}

	deleteAuthCredential(id: number, disabledCause: string): void {
		const row = this.#rows.find(candidate => candidate.id === id);
		if (row) row.disabledCause = disabledCause;
	}

	tryDisableAuthCredentialIfMatches(id: number, expectedData: string, disabledCause: string): boolean {
		const row = this.#rows.find(candidate => candidate.id === id && candidate.disabledCause === null);
		if (!row || serializeCredential(row.credential) !== expectedData) return false;
		row.disabledCause = disabledCause;
		return true;
	}

	replaceAuthCredentialsForProvider(provider: string, credentials: AuthCredential[]): StoredAuthCredential[] {
		this.deleteAuthCredentialsForProvider(provider, "replaced by newer credential");
		const rows = credentials.map(
			(credential): StoredAuthCredential => ({
				id: this.#nextId++,
				provider,
				credential,
				disabledCause: null,
			}),
		);
		this.#rows.push(...rows);
		return rows;
	}

	upsertAuthCredentialForProvider(provider: string, credential: AuthCredential): StoredAuthCredential[] {
		return this.replaceAuthCredentialsForProvider(provider, [credential]);
	}

	deleteAuthCredentialsForProvider(provider: string, disabledCause: string): void {
		for (const row of this.#rows) {
			if (row.provider === provider && row.disabledCause === null) row.disabledCause = disabledCause;
		}
	}

	getCache(): string | null {
		return null;
	}

	setCache(): void {}

	cleanExpiredCache(): void {}
}

function serializeCredential(credential: AuthCredential): string {
	if (credential.type === "api_key") return JSON.stringify({ key: credential.key });
	if (credential.type === "oauth") {
		const { type: _type, ...value } = credential;
		return JSON.stringify(value);
	}
	return "";
}

function oauthCredential(access: string): AuthCredential {
	return {
		type: "oauth",
		access,
		refresh: "test-only-refresh",
		expires: Date.now() + 60_000,
	};
}

describe("local auth references", () => {
	let store: MemoryAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(() => {
		store = new MemoryAuthCredentialStore();
		storage = new AuthStorage(store);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		storage.close();
	});

	test("parses and resolves a provider reference through normal AuthStorage selection", async () => {
		await storage.set(PROVIDER, { type: "api_key", key: "test-only-provider-key" });

		expect(parseLocalAuthRef(`provider:${PROVIDER}`, PROVIDER)).toEqual({
			kind: "provider",
			providerId: PROVIDER,
		});
		expect(await resolveLocalAuthRef(storage, `provider:${PROVIDER}`, PROVIDER)).toBe("test-only-provider-key");
	});

	test("preserves colons inside provider identifiers", () => {
		const providerId = "unit:auth:ref";
		expect(parseLocalAuthRef(`provider:${providerId}`, providerId)).toEqual({
			kind: "provider",
			providerId,
		});
		expect(parseLocalAuthRef(`oauth-credential:${providerId}:23`, providerId)).toEqual({
			kind: "oauth-credential",
			providerId,
			credentialId: 23,
		});
	});

	test("resolves the exact durable OAuth credential row", async () => {
		const exactResolver = vi.spyOn(storage, "getOAuthAccessByCredentialId").mockResolvedValue({
			ok: true,
			accessToken: "test-only-second-access",
			credentialId: 2,
			accountId: "test-only-account",
		});
		const authRef = `oauth-credential:${PROVIDER}:2`;

		expect(parseLocalAuthRef(authRef, PROVIDER)).toEqual({
			kind: "oauth-credential",
			providerId: PROVIDER,
			credentialId: 2,
		});
		expect(await resolveLocalAuthRef(storage, authRef, PROVIDER, { forceRefresh: true })).toBe(
			"test-only-second-access",
		);
		expect(exactResolver).toHaveBeenCalledWith(PROVIDER, 2, {
			signal: undefined,
			forceRefresh: true,
		});
	});

	test.each([
		"",
		"provider:",
		`oauth-credential:${PROVIDER}:0`,
		`oauth-credential:${PROVIDER}:-1`,
		`oauth-credential:${PROVIDER}:1.5`,
		`oauth-credential:${PROVIDER}:01`,
		`oauth-credential:${PROVIDER}:9007199254740992`,
		`api-key:${PROVIDER}`,
	])("rejects malformed reference %j", authRef => {
		expect(() => parseLocalAuthRef(authRef, PROVIDER)).toThrow("Invalid local auth reference");
	});

	test("rejects a provider mismatch before credential access", async () => {
		const providerResolver = vi.spyOn(storage, "getApiKey");
		const oauthResolver = vi.spyOn(storage, "getOAuthAccessByCredentialId");

		await expect(resolveLocalAuthRef(storage, `provider:${PROVIDER}`, "different-provider")).rejects.toThrow(
			"Local auth reference provider does not match the expected provider",
		);
		expect(providerResolver).not.toHaveBeenCalled();
		expect(oauthResolver).not.toHaveBeenCalled();
	});

	test("rejects a missing OAuth credential without exposing credential material", async () => {
		const credentialValue = "must-not-appear-in-errors";
		await storage.set(PROVIDER, oauthCredential(credentialValue));
		const existing = storage.listOAuthAccounts(PROVIDER)[0];
		if (!existing) throw new Error("expected an OAuth credential");
		const missingId = existing.credentialId + 1;

		try {
			await resolveLocalAuthRef(storage, `oauth-credential:${PROVIDER}:${missingId}`, PROVIDER);
			throw new Error("expected resolution to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("OAuth credential was not found");
			expect((error as Error).message).not.toContain(credentialValue);
		}
	});

	test("rejects a non-OAuth credential row as a missing OAuth credential", async () => {
		await storage.set(PROVIDER, { type: "api_key", key: "test-only-provider-key" });
		const row = store.listAuthCredentials(PROVIDER)[0];
		if (!row) throw new Error("expected an API-key credential");

		await expect(resolveLocalAuthRef(storage, `oauth-credential:${PROVIDER}:${row.id}`, PROVIDER)).rejects.toThrow(
			"OAuth credential was not found",
		);
	});

	test("rejects an OAuth credential with no access token", async () => {
		vi.spyOn(storage, "getOAuthAccessByCredentialId").mockResolvedValue({
			ok: true,
			accessToken: "",
			credentialId: 1,
		});

		await expect(resolveLocalAuthRef(storage, `oauth-credential:${PROVIDER}:1`, PROVIDER)).rejects.toThrow(
			"OAuth credential has no access token",
		);
	});
});
