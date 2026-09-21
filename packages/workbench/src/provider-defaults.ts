/** Public connection metadata only. Credentials belong to server-side storage. */
export const DEFAULT_PROVIDER_ID = "opencode-zen";
export const DEFAULT_MODEL_ID = "muse-spark-1.3-contributor-free";
export const DEFAULT_MODEL_NAME = "Muse Spark 1.3 Contributor (free)";
export const TOKENROUTER_URL = "https://api.tokenrouter.com/v1";
export const OPENCODE_ZEN_URL = "https://opencode.ai/zen/v1";
export const PROVIDER_PRESETS = [
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
