import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { BridgeMessage } from "@oh-my-pi/prime-bridge-protocol";

/**
 * Prime peers are addressed as `agent://prime~<percent-encoded session id>`.
 * Local agent ids never contain `~` (task names are `[A-Za-z0-9_-]`), so the
 * prefix cannot shadow a local peer. Not `:`: read/write peel a trailing
 * `:<digits>`/`:raw` as a line selector, so `prime:123` would never route.
 */
export const PRIME_PEER_PREFIX = "prime~";

/** One-line, control-free rendering of untrusted bridge text. */
export function sanitizeBridgeText(value: string): string {
	return replaceTabs(sanitizeText(value))
		.replace(/[\r\n]+/g, " ")
		.trim();
}

/** Host part of the agent:// address for a Prime session id (`prime~<encoded>`). */
export function primePeerAddress(id: string): string {
	if (!id.isWellFormed()) throw new Error("Prime peer ID must be well-formed Unicode");
	return `${PRIME_PEER_PREFIX}${encodeURIComponent(id)}`;
}

/**
 * Prime session id addressed by a decoded agent:// host, or undefined when the
 * host does not carry the Prime prefix or names no well-formed id.
 */
export function primeTargetId(host: string): string | undefined {
	if (!host.startsWith(PRIME_PEER_PREFIX)) return undefined;
	const id = host.slice(PRIME_PEER_PREFIX.length);
	return id.length > 0 && id.isWellFormed() ? id : undefined;
}

export function formatPrimeMessage(message: BridgeMessage): string {
	const replyTag = message.replyTo ? ` (reply to ${sanitizeBridgeText(message.replyTo)})` : "";
	return `[${sanitizeBridgeText(message.meshMessageId)}] ${sanitizeBridgeText(primePeerAddress(message.originSessionId))}${replyTag}: ${sanitizeBridgeText(message.body)}`;
}

export function primeProviderErrorText(op: "list" | "send" | "wait", error: unknown): string {
	const raw = error instanceof Error && error.message.trim().length > 0 ? error.message : "Unknown Prime bridge error";
	return `Prime external peer provider failed during ${op}: ${sanitizeBridgeText(raw)}`;
}
