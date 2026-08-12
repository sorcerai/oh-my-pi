import { type } from "@oh-my-pi/omptype";

export const LOSS_CODES = [
	"missing_source_bytes",
	"unsupported_role",
	"thinking_demoted",
	"provider_payload_demoted",
	"blob_unavailable",
	"entry_metadata_unrepresentable",
] as const;

export const SESSION_LOSS_CODES = LOSS_CODES;
export type SessionLossCode = LossCode;
export type LossCode = (typeof LOSS_CODES)[number];

export interface SessionLoss {
	readonly code: LossCode;
	readonly nodeId?: string;
	readonly detail?: string;
	readonly sourceType?: string;
}

const lossCodeSchema = type(LOSS_CODES.map(code => `'${code}'`).join(" | "));
const lossSchema = type({
	code: lossCodeSchema,
	"nodeId?": "string",
	"detail?": "string",
	"sourceType?": "string",
});

export const lossLedgerSchema = type(lossSchema.array());

export function isLossCode(value: unknown): value is LossCode {
	return typeof value === "string" && (LOSS_CODES as readonly string[]).includes(value);
}

export function validateLossLedger(value: unknown): SessionLoss[] {
	return lossLedgerSchema.assert(value) as SessionLoss[];
}

export function createLoss(code: LossCode, detail?: string, nodeId?: string, sourceType?: string): SessionLoss {
	return {
		code,
		...(nodeId === undefined ? {} : { nodeId }),
		...(detail === undefined ? {} : { detail }),
		...(sourceType === undefined ? {} : { sourceType }),
	};
}
