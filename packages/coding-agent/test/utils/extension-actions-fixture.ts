/**
 * Shared typed `ExtensionActions` fixture for extension-runner tests.
 *
 * Every construction site that calls `ExtensionRunner.initialize` must supply the
 * full action set introduced by Task 0 (Facehugger P0): `runtimeMode` (trusted
 * host provenance) and `refreshRegisteredTools` (dynamic extension-tool refresh +
 * activation delta delegate).
 */
import type {
	ExtensionActions,
	ExtensionRuntimeMode,
	ExtensionToolActivationDelta,
	RefreshRegisteredToolsHandler,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export interface TestExtensionActionsOptions {
	/** Required trusted provenance — never defaulted to avoid masking a missing mode. */
	runtimeMode: ExtensionRuntimeMode;
	/** Required live refresh/delta delegate. */
	refreshRegisteredTools: RefreshRegisteredToolsHandler;
	/** Test-specific overrides for the remaining action handlers. */
	overrides?: Partial<Omit<ExtensionActions, "runtimeMode" | "refreshRegisteredTools">>;
}

/** Recording delegate for compatibility-only runner fixtures. */
export function createRecordingRefreshDelegate(
	calls: ExtensionToolActivationDelta[] = [],
): RefreshRegisteredToolsHandler {
	return async delta => {
		calls.push(delta);
	};
}

/**
 * Build a complete `ExtensionActions` object for `ExtensionRunner.initialize`.
 * The required provenance and refresh delegate are always supplied explicitly;
 * the remaining handlers default to inert test implementations.
 */
export function createTestExtensionActions(options: TestExtensionActionsOptions): ExtensionActions {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
		...options.overrides,
		runtimeMode: options.runtimeMode,
		refreshRegisteredTools: options.refreshRegisteredTools,
	};
}
