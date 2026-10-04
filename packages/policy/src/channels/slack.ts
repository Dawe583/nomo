/**
 * Slack approval channel, WP-05. Webhook delivery is an announcement only.
 *
 * The approval URL belongs to the operator, not this package, so a Slack
 * outage or a missing webhook can only report delivery failure. It must not
 * decide the held call or break the CLI approval path.
 */

import type { HeldCall } from "../hold.ts";

export type SlackPostResult =
  | { readonly kind: "posted"; readonly status: number }
  | { readonly kind: "disabled" }
  | { readonly kind: "failed"; readonly reason: string };

export type SlackChannelOptions = {
  readonly enabled: boolean;
  readonly webhookUrl?: string;
};

/**
 * A Slack failure reason reaches an operator's terminal, a log line and a CI
 * record. Two things in that text are not the operator's to publish: the
 * webhook secret, which Slack puts in the last path segment, and control
 * characters, which a hostile endpoint can use to repaint the terminal that
 * prints the reason. Both are removed here and the result is capped, so a
 * failure reason cannot become a side channel.
 */
const MAX_REASON = 200;

/**
 * The webhook URL is operator configuration rather than remote-user input, so
 * this is not an SSRF boundary against an attacker. It is the boundary that
 * stops a typo, a webhook copied out of a chat log, or a pasted secret from
 * carrying the held call's rationale off the operator's machine, and that
 * stops a redirect from moving the payload to a host the operator never
 * named: a 302 would send the body somewhere else entirely.
 */
export function checkSlackWebhookUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "slack webhook url is not a URL";
  }
  if (url.protocol !== "https:") return "slack webhook url must be https";
  if (url.username !== "" || url.password !== "") return "slack webhook url cannot carry credentials";
  if (url.hash !== "") return "slack webhook url cannot carry a fragment";
  return undefined;
}

function operatorText(text: string, webhookUrl: string): string {
  const path = webhookUrl.split("/");
  const secret = path[path.length - 1] ?? "";
  const withoutSecret =
    secret === ""
      ? text
      : text
          .split(webhookUrl)
          .join("[redacted]")
          .split(secret)
          .join("[redacted]");
  const cleaned = withoutSecret.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim();
  return cleaned.length <= MAX_REASON ? cleaned : `${cleaned.slice(0, MAX_REASON)}…`;
}

type Fetcher = (input: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error" }) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;


type SlackTextObject = {
  readonly type: "plain_text" | "mrkdwn";
  readonly text: string;
};

type SlackButton = {
  readonly type: "button";
  readonly text: SlackTextObject;
  readonly style?: "primary" | "danger";
  readonly url: string;
};

type SlackBlock =
  | { readonly type: "section"; readonly text: SlackTextObject }
  | { readonly type: "actions"; readonly elements: readonly SlackButton[] };

export type SlackPayload = {
  readonly text: string;
  readonly blocks: readonly SlackBlock[];
};

function touched(call: HeldCall): string {
  return call.blastRadius === undefined ? "unknown" : `${call.blastRadius}`;
}

export function slackPayload(call: HeldCall, resolveUrl: (id: string) => string): SlackPayload {
  const title = `held: ${call.tool} (${call.klass}, ${touched(call)} touched)`;
  const rationale = call.rationale ?? "No rationale provided.";
  const base = resolveUrl(call.id);
  const separator = base.includes("?") ? "&" : "?";
  return {
    text: `${title}
${rationale}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title}*
${rationale}` } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            url: `${base}${separator}decision=approve`,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            url: `${base}${separator}decision=deny`,
          },
        ],
      },
    ],
  };
}

export async function postHoldToSlack(
  webhookUrl: string,
  call: HeldCall,
  resolveUrl: (id: string) => string,
  fetcher: Fetcher = globalThis.fetch,
): Promise<SlackPostResult> {
  const refusal = checkSlackWebhookUrl(webhookUrl);
  if (refusal !== undefined) return { kind: "failed", reason: refusal };
  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slackPayload(call, resolveUrl)),
      redirect: "error",
    });
    if (!response.ok) {
      const body = operatorText(await response.text(), webhookUrl);
      return { kind: "failed", reason: `slack webhook returned ${response.status}${body === "" ? "" : `: ${body}`}` };
    }
    return { kind: "posted", status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: operatorText(message, webhookUrl) };
  }
}

export class SlackChannel {
  private readonly enabled: boolean;
  private readonly webhookUrl: string | undefined;
  private readonly fetcher: Fetcher;

  constructor(options: SlackChannelOptions, fetcher: Fetcher = globalThis.fetch) {
    this.enabled = options.enabled;
    this.webhookUrl = options.webhookUrl;
    this.fetcher = fetcher;
  }

  async postHold(call: HeldCall, resolveUrl: (id: string) => string): Promise<SlackPostResult> {
    if (!this.enabled) return { kind: "disabled" };
    if (this.webhookUrl === undefined || this.webhookUrl === "")
      return { kind: "failed", reason: "slack webhook url is required when enabled" };
    return postHoldToSlack(this.webhookUrl, call, resolveUrl, this.fetcher);
  }
}
