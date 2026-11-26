// F-10-2 image-worker의 S3 접근(계획 docs/review/plans/F-10-2.md E3·§3, ADR-0130, D-T35).
// 격리 원본 읽기·검사 태그 읽기·준비 위치 쓰기만 한다. DB·Kafka·Redis 자격 증명은 받지 않는다.
import { GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand, PutBucketPolicyCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ImageWorkerStore {
  read(key: string): Promise<Uint8Array>;
  scanTags(key: string): Promise<Record<string, string>>;
  putStaging(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** 격리 객체가 정한 상한(한 장 10MB)을 넘는다. 서버는 TOO_LARGE로 거절한다. */
export class ImageObjectTooLarge extends Error {
  constructor(readonly bytes: number) {
    super('image object too large');
  }
}

const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const PUBLIC_PREFIXES = ['production', 'banner', 'review'] as const;
const LOCAL_ENVS = new Set(['local', 'ci', 'test']);

export interface S3WorkerStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  /** 로컬 버킷 정책을 열어도 되는 환경(기본 PEAKET_ENV). production이면 endpoint가 있어도 열지 않는다 */
  env?: string;
  /** 격리 객체를 읽는 상한(기본 10MB). 넘으면 읽지 않고 ImageObjectTooLarge를 던진다 */
  maxObjectBytes?: number;
  client?: Pick<S3Client, 'send'>;
}

export class S3WorkerStore implements ImageWorkerStore {
  readonly #client: Pick<S3Client, 'send'>;
  readonly #bucket: string;
  readonly #local: boolean;
  readonly #maxBytes: number;
  #localReady: Promise<void> | undefined;

  constructor(o: S3WorkerStoreOptions) {
    this.#bucket = o.bucket;
    this.#local = o.endpoint !== undefined && LOCAL_ENVS.has(o.env ?? process.env.PEAKET_ENV ?? '');
    this.#maxBytes = o.maxObjectBytes ?? MAX_OBJECT_BYTES;
    this.#client =
      o.client ??
      new S3Client({
        region: o.region,
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } } : {}),
      });
  }

  /** 로컬 moto에서 시험이 서명 없이 읽는 것을 돕기 위해 공개 접두사만 버킷 정책으로 연다(운영은 하지 않는다). */
  async ready(): Promise<void> {
    if (!this.#local) return;
    this.#localReady ??= this.#client
      .send(
        new PutBucketPolicyCommand({
          Bucket: this.#bucket,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: PUBLIC_PREFIXES.map((p) => ({ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${this.#bucket}/${p}/*` })),
          }),
        }),
      )
      .then(() => undefined);
    await this.#localReady;
  }

  async read(key: string): Promise<Uint8Array> {
    // 본문을 받기 전에 ContentLength로 상한을 본다(IR-16). 작게 속아도 아래에서 한 번 더 본다.
    const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
    if ((head.ContentLength ?? 0) > this.#maxBytes) throw new ImageObjectTooLarge(head.ContentLength ?? 0);
    const r = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!r.Body) throw new Error('원본 본문이 없다');
    if ((r.ContentLength ?? 0) > this.#maxBytes) throw new ImageObjectTooLarge(r.ContentLength ?? 0);
    const bytes = new Uint8Array(await r.Body.transformToByteArray());
    if (bytes.length > this.#maxBytes) throw new ImageObjectTooLarge(bytes.length);
    return bytes;
  }

  async scanTags(key: string): Promise<Record<string, string>> {
    const r = await this.#client.send(new GetObjectTaggingCommand({ Bucket: this.#bucket, Key: key }));
    return Object.fromEntries((r.TagSet ?? []).filter((t) => t.Key && t.Value).map((t) => [t.Key!, t.Value!]));
  }

  async putStaging(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.#client.send(new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: 'private, no-store' }));
  }
}
