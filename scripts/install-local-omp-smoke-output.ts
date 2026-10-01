interface StructuredResult {
	status?: string;
	error?: unknown;
	data?: unknown;
}

export function outputCarriesMarker(
	output: unknown,
	structured: StructuredResult | undefined,
	marker: string,
): boolean {
	if (structured !== undefined) {
		return structured.status === "valid" && !structured.error && structured.data === marker;
	}
	if (output === marker) return true;
	if (typeof output !== "string") return false;
	try {
		return JSON.parse(output) === marker;
	} catch {
		return false;
	}
}
