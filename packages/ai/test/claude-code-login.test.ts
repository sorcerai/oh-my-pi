import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClaudeCodeLogin } from "../src/registry/claude-code";

let home: string;
const savedKey = process.env.ANTHROPIC_API_KEY;
const savedTok = process.env.ANTHROPIC_AUTH_TOKEN;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-claude-code-"));
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	process.env.OMP_CLAUDE_CODE_SKIP_KEYCHAIN = "1";
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
	if (savedTok !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedTok;
	delete process.env.OMP_CLAUDE_CODE_SKIP_KEYCHAIN;
});

describe("detectClaudeCodeLogin", () => {
	test("nothing present", async () => {
		expect(await detectClaudeCodeLogin(home)).toEqual({ found: false, source: null, account: null });
	});
	test("credentials file wins and borrows the account label", async () => {
		mkdirSync(join(home, ".claude"));
		writeFileSync(
			join(home, ".claude", ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { accessToken: "x" } }),
		);
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
		expect(await detectClaudeCodeLogin(home)).toEqual({ found: true, source: "credentialsFile", account: "a@b.c" });
	});
	test("claude config marker alone", async () => {
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ userID: "u1" }));
		expect(await detectClaudeCodeLogin(home)).toMatchObject({ found: true, source: "claudeConfig" });
	});
	// Regression: a bare ANTHROPIC_API_KEY must NOT count as "logged in". The
	// subprocess spawn spreads the parent env, so accepting it here would
	// silently switch the CLI to metered per-token billing while every
	// claude-code model spec reports zero cost — a silent cost-tracking
	// blindspot. Metered API-key use belongs to the `anthropic` provider.
	test("bare ANTHROPIC_API_KEY alone is not a login signal", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test";
		expect(await detectClaudeCodeLogin(home)).toEqual({ found: false, source: null, account: null });
	});
	test("bare ANTHROPIC_AUTH_TOKEN alone is not a login signal", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "tok-test";
		expect(await detectClaudeCodeLogin(home)).toEqual({ found: false, source: null, account: null });
	});
});
