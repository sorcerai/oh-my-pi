import { escapeXmlAttribute } from "@oh-my-pi/pi-utils";

export type ExecutorGuidanceProfile = "efficient" | "explicit" | "guardrailed" | "conservative";

const PROFILE_GUIDANCE: Record<ExecutorGuidanceProfile, string> = {
	efficient:
		"The executor is strong. Give thorough but efficient guidance. Prioritize the decisive implementation approach, protected invariants, non-obvious failure modes, and proof. You may summarize routine mechanics, but do not reduce advice to a warning or one-line fix.",
	explicit:
		"The executor benefits from explicit guidance. Name the relevant files, symbols, state transitions, and commands visible in the transcript or your tool evidence. Spell out the safe implementation sequence so the executor does not need to infer missing mechanics.",
	guardrailed:
		"The executor needs detailed guardrails. Give ordered steps. For each applicable step, state exact identifiers, what not to change, the invariant it protects, a stop condition, and the check before continuing. Call out tempting shortcuts that would only suppress the symptom.",
	conservative:
		"The executor capability is unknown. Default to explicit, conservative guidance. Name concrete files, symbols, commands, boundaries, and per-step checks when evidence supplies them. Flag every capability or repository fact you could not verify.",
};

export function classifyExecutorGuidance(modelIdentity: string | undefined): ExecutorGuidanceProfile {
	const identity = (modelIdentity ?? "").toLowerCase();
	if (identity.includes("glm")) return "guardrailed";
	if (identity.includes("kimi") || identity.includes("deepseek")) return "explicit";
	if (identity.includes("gpt-5")) return "efficient";
	return "conservative";
}

export function formatExecutorGuidancePrompt(executorModel: string, profile: ExecutorGuidanceProfile): string {
	const safeExecutorModel = escapeXmlAttribute(executorModel)
		.replace(/\r/g, "&#13;")
		.replace(/\n/g, "&#10;")
		.replace(/\t/g, "&#9;");
	return `<executor-guidance model="${safeExecutorModel}" profile="${profile}">
${PROFILE_GUIDANCE[profile]}

When you call advise with an actionable issue, make the note self-contained enough for this executor to act correctly without another advisor round. Include, when applicable:
- the concrete risk or opportunity and why it matters now
- evidence you personally verified, with exact files and symbols
- the recommended implementation approach in execution order
- invariants and non-goals that constrain the change
- likely edge cases and executor mistakes
- exact verification commands or observable checks
- uncertainty and the next lookup needed to resolve it

Do not send a long note when there is no actionable issue. Prefer silence when the agent is on track. Detail must increase information density, not repetition.
</executor-guidance>`;
}
