import { S3Client, GetBucketVersioningCommand, DeleteObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

function s3Executor(env                             )                               {
  const client = new S3Client({ region: env.AWS_REGION ?? 'us-east-1', ...(env.NOMO_S3_ENDPOINT ? { endpoint: env.NOMO_S3_ENDPOINT, forcePathStyle: true } : {}) });
  return {
    async getObject(input) {
      const result = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key, VersionId: input.versionId }));
      return { body: await result.Body?.transformToByteArray(), etag: result.ETag, versionId: result.VersionId, deleteMarker: result.DeleteMarker };
    },
    async putObject(input) {
      const result = await client.send(new PutObjectCommand({ Bucket: input.bucket, Key: input.key, Body: input.body, IfMatch: input.ifMatch, IfNoneMatch: input.ifNoneMatch }));
      return { etag: result.ETag, versionId: result.VersionId };
    },
    async deleteObject(input) {
      const result = await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key, VersionId: input.versionId }));
      return { versionId: result.VersionId, deleteMarker: result.DeleteMarker };
    },
    async getBucketVersioning(input) {
      const result = await client.send(new GetBucketVersioningCommand({ Bucket: input.bucket }));
      return { status: result.Status, mfaDelete: result.MFADelete };
    },
    close() { client.destroy(); },
  };
}


//# sourceURL=packages/cli/src/s3.ts

export { s3Executor };
