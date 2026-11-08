import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC mode with collab auto-start against the relay in TEST_COLLAB_RELAY_URL;
// only the model is scripted, and it echoes the last user text it was given.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const mock = createMockModel({
	handler: context => {
		const last = context.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
		return { content: [`echo: ${text}`] };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
	convertToLlm,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings: Settings.isolated({
		"compaction.enabled": false,
		"collab.autoStart": "control",
		"collab.relayUrl": process.env.TEST_COLLAB_RELAY_URL,
	}),
	modelRegistry,
});
await runRpcMode(session);
