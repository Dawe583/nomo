import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { Model, ModelMessage, ModelReply } from "../provider.ts";
import { assertProviderDescriptorInManifest } from "../provider-catalog.ts";
import type { HarnessSettings } from "../harness-settings.ts";
import { OpenAIResponsesAdapter } from "./openai-responses.ts";
import { signBedrockRequest, type AwsCredentials } from "./aws-sigv4.ts";
import type { AwsCredentialProvider, ProviderAdapterConfig, ProviderClient } from "./types.ts";

function credentialSecrets(credentials: AwsCredentials | undefined): string[] {
  return [credentials?.secretAccessKey, credentials?.accessKeyId, credentials?.sessionToken]
    .filter((secret): secret is string => Boolean(secret));
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
}

function redactReply(reply: ModelReply, secrets: readonly string[]): ModelReply {
  return {
    ...reply,
    ...(reply.response_id === undefined ? {} : { response_id: redactSecrets(reply.response_id, secrets) }),
    message: {
      ...reply.message,
      content: reply.message.content === null ? null : redactSecrets(reply.message.content, secrets),
      ...(reply.message.tool_call_id === undefined ? {} : { tool_call_id: redactSecrets(reply.message.tool_call_id, secrets) }),
      ...(reply.message.tool_calls === undefined ? {} : {
        tool_calls: reply.message.tool_calls.map(call => ({
          ...call,
          id: redactSecrets(call.id, secrets),
          function: {
            ...call.function,
            name: redactSecrets(call.function.name, secrets),
            arguments: redactSecrets(call.function.arguments, secrets),
          },
        })),
      }),
    },
  };
}

export class BedrockMantleResponsesAdapter implements ProviderClient {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly model: string;
  private readonly request: typeof fetch;
  private readonly settings: Partial<HarnessSettings> | (() => HarnessSettings);
  private readonly now: () => Date;
  private readonly credentialProvider: AwsCredentialProvider;
  private readonly responsesConfig: ProviderAdapterConfig;
  private credentials?: AwsCredentials;

  constructor(
    config: ProviderAdapterConfig,
    request: typeof fetch = fetch,
    settings: Partial<HarnessSettings> | (() => HarnessSettings) = {},
    credentialProvider: AwsCredentialProvider = defaultProvider(),
    now: () => Date = () => new Date(),
  ) {
    if (config.providerId !== "bedrock-mantle" || config.transport !== "openai-responses" || config.auth.kind !== "aws-credential-chain") {
      throw new Error("Bedrock Mantle Responses requires its manifest-approved AWS credential chain.");
    }
    assertProviderDescriptorInManifest(config);
    this.endpoint = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
    const match = this.endpoint.hostname.match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/);
    if (this.endpoint.protocol !== "https:" || !match || this.endpoint.port || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
      throw new Error("Bedrock Mantle requires its official HTTPS endpoint.");
    }
    this.region = match[1]!;
    this.model = config.model!;
    this.request = request;
    this.settings = settings;
    this.now = now;
    this.credentialProvider = credentialProvider;
    this.responsesConfig = { ...config, auth: { kind: "api-key", apiKey: "" } };
  }

  async models(): Promise<readonly Model[]> {
    return [{ id: this.model, name: this.model }];
  }

  async complete(
    model: string,
    messages: readonly ModelMessage[],
    tools: readonly unknown[],
    signal: AbortSignal,
    onDelta?: (text: string) => void | Promise<void>,
  ): Promise<ModelReply> {
    if (model !== this.model) throw new Error("Bedrock Mantle model is not configured.");
    const credentials = await this.resolveCredentials();
    const secrets = credentialSecrets(credentials);
    const responses = new OpenAIResponsesAdapter(
      this.responsesConfig,
      (input, init) => this.requestSigned(input, init, credentials),
      this.settings,
    );
    const stream = onDelta ? this.streamRedactor(onDelta, secrets) : undefined;
    const reply = await responses.complete(model, messages, tools, signal, stream?.emit);
    await stream?.flush();
    return redactReply(reply, secrets);
  }

  redact(text: string): string {
    return redactSecrets(text, credentialSecrets(this.credentials));
  }

  private streamRedactor(
    onDelta: (text: string) => void | Promise<void>,
    secrets: readonly string[],
  ): { emit: (text: string) => Promise<void>; flush: () => Promise<void> } {
    let pending = "";
    return {
      emit: async (delta) => {
        pending = redactSecrets(pending + delta, secrets);
        let hold = 0;
        for (const secret of secrets) {
          for (let index = 1; index < secret.length; index++) {
            if (pending.endsWith(secret.slice(0, index))) hold = Math.max(hold, index);
          }
        }
        const visible = pending.slice(0, pending.length - hold);
        pending = hold ? pending.slice(-hold) : "";
        if (visible) await onDelta(visible);
      },
      flush: async () => {
        const visible = redactSecrets(pending, secrets);
        pending = "";
        if (visible) await onDelta(visible);
      },
    };
  }

  private async requestSigned(
    input: string | URL | Request,
    init: RequestInit | undefined,
    credentials: AwsCredentials,
  ): Promise<Response> {
    const url = input instanceof URL ? new URL(input.href) : new URL(typeof input === "string" ? input : input.url);
    const path = `${this.endpoint.pathname}responses`;
    if (
      url.origin !== this.endpoint.origin ||
      url.username ||
      url.password ||
      url.pathname !== path ||
      url.search ||
      url.hash ||
      init?.method?.toUpperCase() !== "POST" ||
      typeof init.body !== "string"
    ) {
      throw new Error("Bedrock Mantle request is outside the signed Responses contract.");
    }
    const headers = new Headers(init.headers);
    headers.delete("authorization");
    for (const [name, value] of Object.entries(signBedrockRequest(url, init.body, credentials, this.region, this.now(), "bedrock-mantle"))) {
      headers.set(name, value);
    }
    return this.request(url, { ...init, headers, redirect: "error" });
  }

  private async resolveCredentials(): Promise<AwsCredentials> {
    try {
      const credentials = await this.credentialProvider();
      const { accessKeyId, secretAccessKey, sessionToken } = credentials;
      if (
        typeof accessKeyId !== "string" ||
        !accessKeyId ||
        typeof secretAccessKey !== "string" ||
        !secretAccessKey ||
        (sessionToken !== undefined && typeof sessionToken !== "string") ||
        /[\r\n]/.test(accessKeyId + secretAccessKey + (sessionToken ?? ""))
      ) {
        throw new Error("invalid credentials");
      }
      this.credentials = { accessKeyId, secretAccessKey, sessionToken };
      return { accessKeyId, secretAccessKey, sessionToken };
    } catch {
      throw new Error("AWS credential chain could not resolve valid credentials.");
    }
  }
}
