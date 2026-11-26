// F-10-2 image-worker의 S3 접근(계획 docs/review/plans/F-10-2.md E3·§3, ADR-0130, D-T35).
// 격리 원본 읽기·검사 태그 읽기·준비 위치 쓰기만 한다. DB·Kafka·Redis 자격 증명은 받지 않는다.
import { GetObjectCommand, GetObjectTaggingCommand, PutBucketAclCommand, PutBucketPolicyCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ImageWorkerStore {
  read(key: string): Promise<Uint8Array>;
  scanTags(key: string): Promise<Record<string, string>>;
  putStaging(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export interface S3WorkerStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  client?: Pick<S3Client, 'send'>;
}

export class S3WorkerStore implements ImageWorkerStore {
  readonly #client: Pick<S3Client, 'send'>;
  readonly #bucket: string;
  readonly #local: boolean;
  #localReady: Promise<void> | undefined;

  constructor(o: S3WorkerStoreOptions) {
    this.#bucket = o.bucket;
    this.#local = o.endpoint !== undefined;
    this.#client =
      o.client ??
      new S3Client({
        region: o.region,
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } } : {}),
      });
  }

  /** 로컬 moto에서 시험이 서명 없이 읽는 것을 돕기 위해 버킷 정책을 한 번 연다(운영은 하지 않는다). */
  async ready(): Promise<void> {
    if (!this.#local) return;
    this.#localReady ??= this.#client
      .send(
        new PutBucketPolicyCommand({
          Bucket: this.#bucket,
          Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${this.#bucket}/*` }] }),
        }),
      )
      .then(() => this.#client.send(new PutBucketAclCommand({ Bucket: this.#bucket, ACL: 'public-read' })))
      .then(() => undefined);
    await this.#localReady;
  }

  async read(key: string): Promise<Uint8Array> {
    const r = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!r.Body) throw new Error('원본 본문이 없다');
    return new Uint8Array(await r.Body.transformToByteArray());
  }

  async scanTags(key: string): Promise<Record<string, string>> {
    const r = await this.#client.send(new GetObjectTaggingCommand({ Bucket: this.#bucket, Key: key }));
    return Object.fromEntries((r.TagSet ?? []).filter((t) => t.Key && t.Value).map((t) => [t.Key!, t.Value!]));
  }

  async putStaging(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'private, no-store', ...(this.#local ? { ACL: 'public-read' as const } : {}) }));
  }
}
