export type LocalS3FixtureRequest = {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string;
};

export type LocalS3Fixture = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly requests: LocalS3FixtureRequest[];
  createBucket(name: string): void;
  seedObject(bucket: string, key: string, bytes: Uint8Array): void;
  readObject(bucket: string, key: string): Uint8Array | undefined;
  close(): Promise<void>;
};

export function startLocalS3Fixture(options?: {
  readonly host?: string;
  readonly port?: number;
  readonly maxObjectBytes?: number;
}): Promise<LocalS3Fixture>;
