import { directoryExists } from "@oh-my-pi/pi-utils";
import { ClaudeSessionStore } from "./claude-session-store";
import { CodexSessionStore } from "./codex-session-store";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import { OpenCodeSessionStore } from "./opencode-session-store";
import { PiSessionStore } from "./pi-session-store";
import type { SessionInfo } from "./session-listing";
import type { SessionManager } from "./session-manager";

/** Store constructors keyed by foreign source; each builds the importer for that agent. */
const FOREIGN_SESSION_STORES: Record<ForeignSessionSource, () => ForeignSessionStore> = {
	claude: () => new ClaudeSessionStore(),
	codex: () => new CodexSessionStore(),
	pi: () => new PiSessionStore(),
	opencode: () => new OpenCodeSessionStore(),
};

/** Display names keyed by foreign source. */
const FOREIGN_SESSION_SOURCE_NAMES: Record<ForeignSessionSource, string> = {
	claude: "Claude",
	codex: "Codex",
	pi: "Pi",
	opencode: "OpenCode",
};

/** Construct the importer for a supported foreign session source. */
export function createForeignSessionStore(source: ForeignSessionSource): ForeignSessionStore {
	return FOREIGN_SESSION_STORES[source]();
}

/** Display name for a supported foreign session source. */
export function foreignSessionSourceName(source: ForeignSessionSource): string {
	return FOREIGN_SESSION_SOURCE_NAMES[source];
}

/** Convert lightweight foreign metadata for the existing session picker. */
export function foreignSessionInfoToSessionInfo(info: ForeignSessionInfo): SessionInfo {
	const firstMessage = info.firstMessage ?? "(no messages)";
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title,
		created: info.created,
		modified: info.modified,
		messageCount: info.messageCount ?? 0,
		size: 0,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

/** Import and persist one foreign session under a fresh OMP session identity. */
export async function persistForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: { fallbackCwd?: string; sessionDir?: string; suppressBreadcrumb?: boolean },
): Promise<SessionManager> {
	const imported = await store.load(info);
	imported.appendCustomEntry("foreign_session_import", {
		source: info.source,
		sourceId: info.id,
		sourcePath: info.path,
		sourceCwd: info.cwd,
	});
	if (options?.fallbackCwd && !(await directoryExists(imported.getCwd()))) {
		await imported.moveTo(options.fallbackCwd);
	}
	return await imported.persistCopy(options);
}
