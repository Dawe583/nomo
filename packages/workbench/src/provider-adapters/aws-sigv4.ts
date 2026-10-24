import { createHash, createHmac } from "node:crypto";

export type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

export function signSigV4String(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
  stringToSign: string,
): string {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  return hmac(signingKey, stringToSign).toString("hex");
}

function canonicalPath(pathname: string): string {
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `${pathname.startsWith("/") ? "/" : ""}${segments.join("/")}${segments.length && pathname.endsWith("/") ? "/" : ""}`;
  return normalized.split("/").map(segment =>
    encodeURIComponent(segment)
      .replace(/%25([0-9a-f]{2})/gi, (_match, hex: string) => `%${hex.toUpperCase()}`)
      .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
  ).join("/");
}

export function signBedrockRequest(
  url: URL,
  body: string,
  credentials: AwsCredentials,
  region: string,
  now: Date,
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) canonicalHeaders["x-amz-security-token"] = credentials.sessionToken;
  const signedHeaders = Object.keys(canonicalHeaders).sort().join(";");
  const headerText = Object.keys(canonicalHeaders).sort().map(name => `${name}:${canonicalHeaders[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = ["POST", canonicalPath(url.pathname), "", headerText, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/bedrock/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = signSigV4String(credentials.secretAccessKey, dateStamp, region, "bedrock", stringToSign);
  return {
    "content-type": "application/json",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
