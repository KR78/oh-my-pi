import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const VEC_GATEWAY_URL = "https://ug.vec.run";

export const loginVec = createApiKeyLogin({
	providerLabel: "Vec Gateway",
	authUrl: VEC_GATEWAY_URL,
	instructions:
		"Paste your ug.vec.run external API key. Keys are issued on the gateway (admin → /admin/keys) or via the seed_keys script.",
	promptMessage: "Paste your Vec Gateway (ug.vec.run) API key",
	placeholder: "ugk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Vec Gateway",
		modelsUrl: `${VEC_GATEWAY_URL}/v1/models`,
	},
});

export const vecProvider = {
	id: "vec",
	name: "Vec Gateway",
	login: (cb: OAuthLoginCallbacks) => loginVec(cb),
} as const satisfies ProviderDefinition;