import { type SessionSpecV1, SessionSpecValidationError, sessionSpecSchema, validateSessionSpec } from "./spec";

export { SessionSpecValidationError, sessionSpecSchema, validateSessionSpec };
export const SessionSpecSchema = sessionSpecSchema;

export function parseSessionSpec(value: unknown): SessionSpecV1 {
	return validateSessionSpec(value);
}
