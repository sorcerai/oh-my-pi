/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../../config/registry";

const EMPTY_STRING_ARRAY: string[] = [];

export const PRIME_BRIDGE_APPROVAL_TIMEOUT_MIN_MS = 1;
export const PRIME_BRIDGE_APPROVAL_TIMEOUT_MAX_MS = 60_000;

/** @throws Error when `value` is set but not a finite millisecond count within the allowed range. */
export function validatePrimeBridgeApprovalTimeoutMs(value: unknown): void {
	if (
		value !== undefined &&
		(typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < PRIME_BRIDGE_APPROVAL_TIMEOUT_MIN_MS ||
			value > PRIME_BRIDGE_APPROVAL_TIMEOUT_MAX_MS)
	) {
		throw new Error(
			`Prime bridge approvalTimeoutMs must be between ${PRIME_BRIDGE_APPROVAL_TIMEOUT_MIN_MS} and ${PRIME_BRIDGE_APPROVAL_TIMEOUT_MAX_MS} milliseconds`,
		);
	}
}

export const cfgPrimeBridgeEnabled = register({ id: "primeBridge.enabled", type: "boolean", default: false });

export const cfgPrimeBridgeUrl = register({ id: "primeBridge.url", type: "string", default: undefined });

export const cfgPrimeBridgeTokenPath = register({ id: "primeBridge.tokenPath", type: "string", default: undefined });

export const cfgPrimeBridgeAutoStart = register({ id: "primeBridge.autoStart", type: "boolean", default: false });

export const cfgPrimeBridgeToolHostEnabled = register({
	id: "primeBridge.toolHost.enabled",
	type: "boolean",
	default: false,
});

export const cfgPrimeBridgeToolHostAllowTools = register({
	id: "primeBridge.toolHost.allowTools",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgPrimeBridgeToolHostDefaultTools = register({
	id: "primeBridge.toolHost.defaultTools",
	type: "boolean",
	default: true,
});

export const cfgPrimeBridgeToolHostSessionId = register({
	id: "primeBridge.toolHost.sessionId",
	type: "string",
	default: undefined,
});

export const cfgPrimeBridgeToolHostApprovalTimeoutMs = register({
	id: "primeBridge.toolHost.approvalTimeoutMs",
	type: "number",
	default: PRIME_BRIDGE_APPROVAL_TIMEOUT_MAX_MS,
	validate: validatePrimeBridgeApprovalTimeoutMs,
});
