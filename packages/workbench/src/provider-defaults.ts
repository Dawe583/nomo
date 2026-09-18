/** Public connection metadata only. Credentials belong to server-side storage. */
export const DEFAULT_PROVIDER_ID = "tokenharbor";
export const DEFAULT_MODEL_ID = "mimo-v2.5:free";
export const DEFAULT_MODEL_NAME = "mimo-v2.5:free";
export const TOKENROUTER_URL = "https://api.tokenrouter.com/v1";
export const TOKENHARBOR_URL = "https://tokenharbor.ai/v1";
export const PROVIDER_PRESETS = [
  {
    id: "pollinations",
    name: "Pollinations (free, no key)",
    baseUrl: "https://text.pollinations.ai/openai",
    kind: "openai",
  },
  {
    id: "tokenharbor",
    name: "Token Harbor",
    baseUrl: TOKENHARBOR_URL,
    kind: "openai",
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    kind: "openai",
  },
  {
    id: "tokenrouter",
    name: "TokenRouter",
    baseUrl: TOKENROUTER_URL,
    kind: "openai",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    kind: "openai",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    kind: "openai",
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
    kind: "openai",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    kind: "openai",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    kind: "openai",
  },
  {
    id: "gateway",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    kind: "openai",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    kind: "openai",
    local: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    kind: "openai",
    local: true,
  },
] as const;
