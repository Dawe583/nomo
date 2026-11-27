import test from "node:test";
import assert from "node:assert/strict";

import { startLocalS3Fixture } from "../../../scripts/src/local-s3-fixture.mjs";
import { s3Executor } from "./s3.ts";

test("s3Executor uses scoped AWS credentials from its injected environment", async (t) => {
  const fixture = await startLocalS3Fixture({ port: 0 });
  t.after(() => fixture.close());
  fixture.createBucket("fixture-bucket");
  const client = s3Executor({
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "scoped-access",
    AWS_SECRET_ACCESS_KEY: "scoped-secret",
    NOMO_S3_ENDPOINT: fixture.url,
  });
  t.after(() => client.close());

  await client.putObject({ bucket: "fixture-bucket", key: "object", body: new TextEncoder().encode("bytes") });
  const object = await client.getObject({ bucket: "fixture-bucket", key: "object" });
  assert.equal(new TextDecoder().decode(object.body), "bytes");
  assert.match(
    fixture.requests.map((request) => request.authorization).join("\n"),
    /AWS4-HMAC-SHA256 Credential=scoped-access\//,
  );
});
