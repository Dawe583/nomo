import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startLocalS3Fixture } from "./local-s3-fixture.mjs";

const require = createRequire(new URL("../../packages/cli/package.json", import.meta.url));
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, GetBucketVersioningCommand } = require("@aws-sdk/client-s3");

async function awsClient(t, fixture) {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: fixture.url,
    forcePathStyle: true,
    credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" },
  });
  t.after(() => client.destroy());
  return client;
}

test("the real AWS SDK round-trips bytes over loopback HTTP", async (t) => {
  const fixture = await startLocalS3Fixture({ port: 0 });
  t.after(() => fixture.close());
  fixture.createBucket("fixture-bucket");
  const client = await awsClient(t, fixture);
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);

  const put = await client.send(new PutObjectCommand({ Bucket: "fixture-bucket", Key: "nested/object.bin", Body: bytes }));
  assert.match(put.ETag, /^"[a-f0-9]{32}"$/);
  const got = await client.send(new GetObjectCommand({ Bucket: "fixture-bucket", Key: "nested/object.bin" }));
  assert.deepEqual([...await got.Body.transformToByteArray()], [...bytes]);
  assert.equal(got.ETag, put.ETag);
  assert.ok(fixture.requests.every((request) => request.authorization.startsWith("AWS4-HMAC-SHA256 ")));
});

test("missing keys, conditional writes, delete and versioning follow the implemented S3 subset", async (t) => {
  const fixture = await startLocalS3Fixture({ port: 0 });
  t.after(() => fixture.close());
  fixture.createBucket("fixture-bucket");
  const client = await awsClient(t, fixture);

  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: "fixture-bucket", Key: "missing" })),
    (error) => error.name === "NoSuchKey" && error.$metadata.httpStatusCode === 404,
  );
  await client.send(new PutObjectCommand({ Bucket: "fixture-bucket", Key: "object", Body: "before" }));
  await assert.rejects(
    client.send(new PutObjectCommand({ Bucket: "fixture-bucket", Key: "object", Body: "replace", IfNoneMatch: "*" })),
    (error) => error.name === "PreconditionFailed" && error.$metadata.httpStatusCode === 412,
  );
  await assert.rejects(
    client.send(new PutObjectCommand({ Bucket: "fixture-bucket", Key: "object", Body: "replace", IfMatch: '"wrong"' })),
    (error) => error.name === "PreconditionFailed" && error.$metadata.httpStatusCode === 412,
  );
  const deleted = await client.send(new DeleteObjectCommand({ Bucket: "fixture-bucket", Key: "object" }));
  assert.equal(deleted.$metadata.httpStatusCode, 204);
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: "fixture-bucket" }));
  assert.equal(versioning.Status, "Disabled");
});

test("the fixture refuses non-loopback binding before opening a socket", async () => {
  await assert.rejects(() => startLocalS3Fixture({ host: "0.0.0.0" }), /loopback/);
});
