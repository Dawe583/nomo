/** Public connection metadata only. Credentials belong to server-side storage.
 *
 * There is no default provider and no default model. A workspace with nothing
 * configured has neither, and the surfaces say so rather than naming a vendor.
 * The presets below are the choices on offer; offering a choice is not the same
 * as choosing for the operator.
 */

/** The no-cost model each origin serves, keyed by that origin. A transient
 * rejection of the named model is retried; a paid model on the same endpoint is
 * never retried, and neither is any model this table does not name. Naming the
 * model per endpoint is what keeps the guard from becoming "retry everything".
 * TokenHarbor has no preset because it is a hand-typed endpoint, and it is
 * listed here for the same reason: the guard tests the origin, not a preset. */
export const FREE_MODEL_BY_ORIGIN: Readonly<Record<string, string>> = {
  "https://api.tokenrouter.com": "z-ai/glm-5.3-flash",
  "https://text.pollinations.ai": "z-ai/glm-5.3-flash",
  "https://tokenharbor.ai": "z-ai/glm-5.3-flash",
};

/** Public endpoints. A preset is a choice, so these stay exported. */
export const NVIDIA_URL = "https://integrate.api.nvidia.com/v1";
export const TOKENROUTER_URL = "https://api.tokenrouter.com/v1";
export const OPENCODE_ZEN_URL = "https://opencode.ai/zen/v1";
export const PROVIDER_PRESETS = [
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: NVIDIA_URL,
    kind: "compatible",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: OPENCODE_ZEN_URL,
    kind: "compatible",
  },
  {
    id: "pollinations",
    name: "Pollinations (free, no key)",
    baseUrl: "https://text.pollinations.ai/openai",
    kind: "compatible",
  },
  {
    id: "tokenrouter",
    name: "TokenRouter",
    baseUrl: TOKENROUTER_URL,
    kind: "compatible",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    kind: "compatible",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    kind: "anthropic",
  },
  {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    kind: "compatible",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    kind: "compatible",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    kind: "compatible",
  },
  {
    id: "gateway",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    kind: "compatible",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    kind: "compatible",
    local: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    kind: "compatible",
    local: true,
  },
] as const;
