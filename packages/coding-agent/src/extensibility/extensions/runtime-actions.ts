import type { AgentSession } from "../../session/agent-session";
import type { ExtensionRunner } from "./runner";
import type { ExtensionActions, ExtensionRuntimeMode, ExtensionToolActivationDelta } from "./types";

export type ExtensionRuntimeActions = Pick<ExtensionActions, "runtimeMode" | "refreshRegisteredTools">;

/** Build the host-owned provenance and live extension-refresh delegate. */
export function createExtensionRuntimeActions(
	session: AgentSession,
	runner: ExtensionRunner,
	runtimeMode: ExtensionRuntimeMode,
	isAllowedToolName: (name: string) => boolean = () => true,
): ExtensionRuntimeActions {
	const filterDelta = (delta: ExtensionToolActivationDelta): ExtensionToolActivationDelta => ({
		activate: delta.activate?.filter(isAllowedToolName),
		deactivate: delta.deactivate?.filter(isAllowedToolName),
	});
	return {
		runtimeMode,
		refreshRegisteredTools: delta =>
			session.refreshExtensionTools(runner.getAllRegisteredTools(), filterDelta(delta)),
	};
}

export function createNoninteractiveExtensionRuntimeActions(
	session: AgentSession,
	runner: ExtensionRunner,
): ExtensionRuntimeActions {
	return createExtensionRuntimeActions(session, runner, "noninteractive");
}

export function createAcpExtensionRuntimeActions(
	session: AgentSession,
	runner: ExtensionRunner,
): ExtensionRuntimeActions {
	return createExtensionRuntimeActions(session, runner, "acp");
}

export function createLocalInteractiveExtensionRuntimeActions(
	session: AgentSession,
	runner: ExtensionRunner,
): ExtensionRuntimeActions {
	return createExtensionRuntimeActions(session, runner, "local-interactive");
}

export function createTaskExtensionRuntimeActions(
	session: AgentSession,
	runner: ExtensionRunner,
	isParentOwnedTool: (name: string) => boolean,
): ExtensionRuntimeActions {
	return createExtensionRuntimeActions(session, runner, "task", name => !isParentOwnedTool(name));
}
