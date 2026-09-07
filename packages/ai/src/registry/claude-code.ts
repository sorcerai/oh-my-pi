import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LoginHook } from "./hooks/types";

const execFileAsync = promisify(execFile);

export const CLAUDE_CODE_LOGIN_PLACEHOLDER = "claude-code-login";

export interface ClaudeCodeLoginState {
	found: boolean;
	source: "keychain" | "credentialsFile" | "claudeConfig" | null;
	account: string | null;
}

function fileHasContent(path: string): boolean {
	try {
		return statSync(path).size > 0;
	} catch {
		return false;
	}
}

function readAccountLabel(home: string): { marker: boolean; label: string | null } {
	try {
		const raw = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
		const acct = (raw.oauthAccount ?? null) as Record<string, unknown> | null;
		const label =
			(typeof acct?.emailAddress === "string" && acct.emailAddress) ||
			(typeof acct?.displayName === "string" && acct.displayName) ||
			null;
		const marker = Boolean(label || (acct && typeof acct.accountUuid === "string") || typeof raw.userID === "string");
		return { marker, label };
	} catch {
		return { marker: false, label: null };
	}
}

async function keychainHasCredentials(): Promise<boolean> {
	if (process.platform !== "darwin" || process.env.OMP_CLAUDE_CODE_SKIP_KEYCHAIN) return false;
	try {
		await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect Claude Code's own subscription login state. Never throws.
 *
 * Deliberately does NOT treat a bare `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
 * as "logged in": this provider spawns the Claude CLI with the parent env
 * (see claude-agent-sdk.ts), and the CLI prefers an API key over subscription
 * auth when both could apply — so accepting a bare key here would silently
 * switch the subprocess to metered per-token billing while every model in
 * claude-code-static.ts reports zero cost. Callers who want metered API-key
 * billing should use the `anthropic` provider instead, which computes real
 * cost from usage.
 */
export async function detectClaudeCodeLogin(home: string = homedir()): Promise<ClaudeCodeLoginState> {
	const { marker, label } = readAccountLabel(home);
	if (await keychainHasCredentials()) return { found: true, source: "keychain", account: label };
	if (fileHasContent(join(home, ".claude", ".credentials.json")))
		return { found: true, source: "credentialsFile", account: label };
	if (marker) return { found: true, source: "claudeConfig", account: label };
	return { found: false, source: null, account: null };
}

/** `login "custom" hook="claude-code"` (`rules/auth/claude-code.kdl`). */
export const loginClaudeCodeHook: LoginHook = async cb => {
	cb.onProgress?.("Checking Claude Code login state...");
	const state = await detectClaudeCodeLogin();
	if (!state.found) {
		throw new Error("Claude Code is not logged in. Run 'claude login' in a terminal, then retry /login claude-code.");
	}
	cb.onProgress?.(`Claude Code login found (${state.source}${state.account ? `, ${state.account}` : ""}).`);
	return CLAUDE_CODE_LOGIN_PLACEHOLDER;
};
