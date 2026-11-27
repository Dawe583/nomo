import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/**
 * Loopback-only S3 wire fixture for the real AWS SDK client. It implements the
 * small unversioned object subset NOMO replay uses; it is not independent
 * MinIO/AWS certification and it does not validate SigV4 signatures.
 */
export async function startLocalS3Fixture(options = {}) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("local S3 fixture must bind to loopback");
  const maxObjectBytes = options.maxObjectBytes ?? MAX_OBJECT_BYTES;
  const buckets = new Map();
  const requests = [];

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, { buckets, requests, maxObjectBytes }).catch((error) => {
      writeError(response, 500, "InternalError", error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "object" && typeof address.port !== "number")
    throw new Error("local S3 fixture did not expose a loopback port");
  const port = typeof address === "object" ? address.port : 0;
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    requests,
    createBucket(name) {
      assertBucketName(name);
      if (buckets.has(name)) throw new Error(`fixture bucket already exists: ${name}`);
      buckets.set(name, new Map());
    },
    seedObject(bucket, key, bytes) {
      const objects = needBucket(buckets, bucket);
      objects.set(key, objectRecord(bytes));
    },
    readObject(bucket, key) {
      const stored = needBucket(buckets, bucket).get(key);
      return stored === undefined ? undefined : new Uint8Array(stored.body);
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function handleRequest(request, response, state) {
  const method = request.method ?? "";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").slice(1).map(decodePathPart);
  const bucket = parts[0] ?? "";
  const key = parts.slice(1).join("/");
  state.requests.push({ method, path: url.pathname, query: url.search, authorization: request.headers.authorization ?? "" });

  if (typeof request.headers.authorization !== "string" || !request.headers.authorization.startsWith("AWS4-HMAC-SHA256 ")) {
    writeError(response, 403, "AccessDenied", "fixture requires a SigV4-shaped Authorization header");
    return;
  }
  if (!state.buckets.has(bucket)) {
    writeError(response, 404, "NoSuchBucket", "fixture bucket does not exist");
    return;
  }
  const objects = state.buckets.get(bucket);

  if (method === "GET" && key === "" && url.searchParams.has("versioning")) {
    writeXml(response, 200, `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Disabled</Status><MfaDelete>Disabled</MfaDelete></VersioningConfiguration>`);
    return;
  }
  if (key === "") {
    writeError(response, 400, "InvalidRequest", "fixture only implements object operations and GetBucketVersioning");
    return;
  }

  if (method === "GET") {
    const stored = objects.get(key);
    if (stored === undefined) {
      writeError(response, 404, "NoSuchKey", "fixture object does not exist");
      return;
    }
    response.writeHead(200, { "content-length": stored.body.byteLength, etag: stored.etag });
    response.end(stored.body);
    return;
  }

  if (method === "PUT") {
    const existing = objects.get(key);
    if (request.headers["if-none-match"] === "*" && existing !== undefined) {
      writeError(response, 412, "PreconditionFailed", "object already exists");
      return;
    }
    const ifMatch = request.headers["if-match"];
    if (typeof ifMatch === "string" && (existing === undefined || existing.etag !== ifMatch)) {
      writeError(response, 412, "PreconditionFailed", "object etag does not match");
      return;
    }
    const body = await readBody(request, state.maxObjectBytes);
    const stored = objectRecord(body);
    objects.set(key, stored);
    response.writeHead(200, { etag: stored.etag });
    response.end();
    return;
  }

  if (method === "DELETE") {
    objects.delete(key);
    response.writeHead(204);
    response.end();
    return;
  }

  writeError(response, 400, "InvalidRequest", `unsupported fixture method ${method}`);
}

function objectRecord(bytes) {
  const body = new Uint8Array(bytes);
  return { body, etag: `"${createHash("md5").update(body).digest("hex")}"` };
}

async function readBody(request, maxObjectBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > maxObjectBytes) throw Object.assign(new Error("fixture object exceeds byte budget"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeXml(response, status, xml, headers = {}) {
  const body = Buffer.from(xml);
  response.writeHead(status, { "content-type": "application/xml", "content-length": body.byteLength, ...headers });
  response.end(body);
}

function writeError(response, status, code, message) {
  writeXml(response, status, `<Error><Code>${xml(code)}</Code><Message>${xml(message)}</Message></Error>`);
}

function decodePathPart(part) {
  try { return decodeURIComponent(part); }
  catch { return part; }
}

function assertBucketName(name) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) throw new Error(`invalid fixture bucket name: ${name}`);
}

function needBucket(buckets, bucket) {
  assertBucketName(bucket);
  const objects = state.buckets.get(bucket);
  if (objects === undefined) throw new Error(`fixture bucket does not exist: ${bucket}`);
  return objects;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
