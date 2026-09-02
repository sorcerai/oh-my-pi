import type { ClaudeSdkHandlers, ClaudeSdkPermissionRequest, ClaudeSdkPermissionResult } from "@oh-my-pi/pi-ai";
import { claudeCodeToolTier } from "@oh-my-pi/pi-ai";
import { type ApprovalMode, resolveApproval, truncateForPrompt } from "./tools/approval";

/** Session entry type carrying the resumable Claude Agent SDK session id. */
export const CLAUDE_SDK_SESSION_CUSTOM_TYPE = "claude_sdk_session";

export interface ClaudeSdkBridgeOptions {
	getSettings(): { get(key: string): unknown } | undefined;
	isAutoApprove(): boolean;
	hasUI(): boolean;
	select(prompt: string, choices: string[], opts: { signal?: AbortSignal }): Promise<string | undefined>;
	loadPersistedSessionId(): string | undefined;
	persistSessionId(id: string | undefined): void;
}

/** Host side of the claude-agent-sdk provider: session continuity + approval routing. */
export class ClaudeSdkBridge implements ClaudeSdkHandlers {
	#sessionId: string | undefined;
	#loaded = false;

	constructor(private readonly options: ClaudeSdkBridgeOptions) {}

	getSdkSessionId(): string | undefined {
		if (!this.#loaded) {
			this.#sessionId = this.options.loadPersistedSessionId();
			this.#loaded = true;
		}
		return this.#sessionId;
	}

	setSdkSessionId(id: string): void {
		this.#loaded = true;
		if (this.#sessionId === id) return;
		this.#sessionId = id;
		this.options.persistSessionId(id);
	}

	resetSdkSession(): void {
		// Load first. A reset landing before the first read must still tombstone an
		// id persisted by an earlier process, or the next resume revives it.
		if (this.getSdkSessionId() === undefined) return;
		this.#sessionId = undefined;
		// Persisted as a tombstone entry: the loader takes the LAST
		// claude_sdk_session entry on the branch, so an absent id reads back as
		// "no session" without rewriting history.
		this.options.persistSessionId(undefined);
	}

	/**
	 * Drop cached state so the next read re-loads from whatever branch is now
	 * current. Unlike `resetSdkSession()` this persists nothing: the host is
	 * moving to a transcript that owns its own id, not discarding one.
	 */
	forgetSdkSession(): void {
		this.#sessionId = undefined;
		this.#loaded = false;
	}

	async requestToolPermission(req: ClaudeSdkPermissionRequest): Promise<ClaudeSdkPermissionResult> {
		const settings = this.options.getSettings();
		const mode: ApprovalMode = this.options.isAutoApprove()
			? "yolo"
			: ((settings?.get("tools.approvalMode") as ApprovalMode | undefined) ?? "yolo");
		const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
		const tier = claudeCodeToolTier(req.toolName);
		const policyKey = `claude-code.${req.toolName}`;
		const resolved = resolveApproval({ name: policyKey, approval: tier }, req.input, mode, userPolicies);
		if (resolved.policy === "allow") return { behavior: "allow" };
		if (resolved.policy === "deny") {
			return {
				behavior: "deny",
				message: `Tool "${req.toolName}" is blocked by omp policy (tools.approval.${policyKey}: deny).`,
			};
		}
		if (!this.options.hasUI()) {
			return {
				behavior: "deny",
				message:
					`Tool "${req.toolName}" requires approval but omp has no interactive UI. ` +
					`Set tools.approvalMode: yolo or tools.approval.${policyKey}: allow.`,
			};
		}
		const prompt = `Claude Code wants to run ${req.toolName} (${tier}):\n${truncateForPrompt(JSON.stringify(req.input, null, 2))}`;
		let choice: string | undefined;
		try {
			choice = await this.options.select(prompt, ["Approve", "Deny"], { signal: req.signal });
		} catch {
			// Abort (or a UI failure) fails closed.
			return { behavior: "deny", message: "Approval aborted in omp." };
		}
		return choice === "Approve" ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user in omp." };
	}
}
