import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRestore } from './apply.ts';
import type { S3Client } from './classify.ts';
import { sha256 } from './capture.ts';

test('a concurrent S3 writer makes conditional restoration refuse instead of overwrite', async () => {
  const bytes = new TextEncoder().encode('before');
  const reference = { namespace: 's3', uri: 'memory://before', digest: sha256(bytes) };
  const client: S3Client = {
    getObject: async () => ({ body: bytes, etag: 'known-etag' }),
    putObject: async input => {
      assert.equal(input.ifMatch, 'known-etag');
      throw { $metadata: { httpStatusCode: 412 } };
    },
    deleteObject: async () => ({}), getBucketVersioning: async () => ({}),
  };
  const result = await applyRestore({ get: async () => bytes, put: async () => ({ reference, digest: reference.digest }) }, client, { stepId: 'restore', call: { bucket: 'fixture', key: 'fixture' }, reference, capturedEtag: 'known-etag' });
  assert.deepEqual(result, { applied: [], refused: [{ stepId: 'restore', reason: 'drift', changed: [] }] });
});

test('S3 read failures refuse without leaking upstream credentials or performing writes',async()=>{
  let writes=0;const client:S3Client={getObject:async()=>{throw Object.assign(new Error('private-service-credential'),{statusCode:403})},putObject:async()=>{writes++;return{}},deleteObject:async()=>({}),getBucketVersioning:async()=>({})};
  const bytes=new Uint8Array(),reference={namespace:'test',uri:'memory://test',digest:sha256(bytes)};
  const report=await applyRestore({get:async()=>bytes,put:async()=>({reference,digest:reference.digest})},client,{stepId:'restore',call:{bucket:'fixture',key:'fixture'},reference});
  assert.equal(writes,0);assert.equal(report.refused[0]?.reason,'permission_denied');assert.doesNotMatch(JSON.stringify(report),/private-service/);
});

test('a restore is proved by reading the object back, and the proof is stored', async () => {
  const bytes = new TextEncoder().encode('before');
  const reference = { namespace: 's3', uri: 'memory://before', digest: sha256(bytes) };
  const stored: Array<{ namespace: string; bytes: Uint8Array }> = [];
  const store = {
    get: async () => bytes,
    put: async (namespace: string, body: Uint8Array) => {
      stored.push({ namespace, bytes: body });
      const digest = sha256(body);
      return { reference: { namespace, uri: `memory://${digest}`, digest }, digest };
    },
  };
  let reads = 0;
  const client: S3Client = {
    getObject: async () => {
      if (reads++ === 0) throw { name: 'NoSuchKey' };
      return { body: bytes, etag: 'written-etag', versionId: 'v1' };
    },
    putObject: async () => ({ etag: 'written-etag', versionId: 'v1' }),
    deleteObject: async () => ({}),
    getBucketVersioning: async () => ({}),
  };

  const report = await applyRestore(store, client, {
    stepId: 'restore',
    call: { bucket: 'fixture', key: 'fixture' },
    reference,
    capturedEtag: 'known-etag',
  });

  assert.equal(reads, 2, 'the object is read once before and once after the write');
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.applied, ['restore']);
  const receipt = report.receipts![0]!;
  assert.equal(receipt.bucket, 'fixture');
  assert.equal(receipt.restoredDigest, sha256(bytes));
  assert.equal(receipt.capturedDigest, reference.digest);
  assert.equal(receipt.reference, sha256(stored[0]!.bytes));
  assert.equal(stored[0]!.namespace, 's3-restore');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(stored[0]!.bytes)), {
    version: 'void.s3.restore.v1',
    stepId: 'restore',
    bucket: 'fixture',
    key: 'fixture',
    restoredDigest: sha256(bytes),
    capturedDigest: reference.digest,
    etag: 'written-etag',
    versionId: 'v1',
    verifiedAt: receipt.verifiedAt,
  });
});

test('a restore whose bytes come back different refuses instead of claiming it applied', async () => {
  const bytes = new TextEncoder().encode('before');
  const other = new TextEncoder().encode('transformed-by-the-bucket');
  const reference = { namespace: 's3', uri: 'memory://before', digest: sha256(bytes) };
  let reads = 0;
  const client: S3Client = {
    getObject: async () => {
      if (reads++ === 0) throw { name: 'NoSuchKey' };
      return { body: other, etag: 'written-etag' };
    },
    putObject: async () => ({ etag: 'written-etag' }),
    deleteObject: async () => ({}),
    getBucketVersioning: async () => ({}),
  };

  const report = await applyRestore(
    { get: async () => bytes, put: async () => { throw new Error('a refused restore stores no receipt'); } },
    client,
    { stepId: 'restore', call: { bucket: 'fixture', key: 'fixture' }, reference, capturedEtag: 'known-etag' },
  );

  assert.deepEqual(report.applied, []);
  assert.equal(report.refused[0]?.reason, 'verification_failed');
  assert.equal(report.refused[0]?.changed[0]?.field, 'body');
  assert.equal(report.refused[0]?.changed[0]?.capturedDigest, sha256(bytes));
  assert.equal(report.refused[0]?.changed[0]?.currentDigest, sha256(other));
  assert.equal(report.receipts, undefined);
});

test('a restore that cannot be read back says so instead of reporting a mismatch', async () => {
  const bytes = new TextEncoder().encode('before');
  const reference = { namespace: 's3', uri: 'memory://before', digest: sha256(bytes) };
  let reads = 0;
  const client: S3Client = {
    getObject: async () => {
      if (reads++ === 0) throw { name: 'NoSuchKey' };
      throw Object.assign(new Error('read-after-write failed'), { statusCode: 503 });
    },
    putObject: async () => ({ etag: 'written-etag' }),
    deleteObject: async () => ({}),
    getBucketVersioning: async () => ({}),
  };

  const report = await applyRestore(
    { get: async () => bytes, put: async () => ({ reference, digest: reference.digest }) },
    client,
    { stepId: 'restore', call: { bucket: 'fixture', key: 'fixture' }, reference, capturedEtag: 'known-etag' },
  );

  assert.deepEqual(report, {
    applied: [],
    refused: [{ stepId: 'restore', reason: 'verification_unavailable', changed: [] }],
  });
});
