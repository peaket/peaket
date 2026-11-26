// F-10-2 S3 이미지 저장소 어댑터(계획 docs/review/plans/F-10-2.md E3·§3, docs/data.md §1, ADR-0257 결정 1).
// 키는 서버가 만든 이미지 ID와 종류·폭·형식만 받는다. 공개 파생본은 immutable 캐시·inline 파일 이름으로 쓰고 덮어쓰지 않는다.
// 격리 원본·준비 위치는 비공개(private, no-store)다. endpoint가 있으면 moto/로컬 path-style이다.
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutBucketAclCommand, PutBucketPolicyCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ImageObjectStore } from '../domain/media-ports.js';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KIND = '(?:production|banner|review)';
const NAME = '(?:(?:320|640|960|1280)\\.(?:avif|webp)|(?:240|1280)\\.webp)';
const QUARANTINE = new RegExp(`^quarantine/${KIND}/${ID}$`);
const STAGING = new RegExp(`^staging/${KIND}/${ID}/${NAME}$`);
const PUBLIC = new RegExp(`^${KIND}/${ID}/${NAME}$`);
const CONTENT_TYPES: Record<string, string> = { webp: 'image/webp', avif: 'image/avif' };
const PUBLIC_CACHE = 'public, max-age=31536000, immutable';
const PRIVATE_CACHE = 'private, no-store';

function checked(re: RegExp, key: string): string {
  if (!re.test(key)) throw new Error('정한 꼴이 아닌 객체 키');
  return key;
}
function isNotFound(e: unknown): boolean {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === 'NoSuchKey' || x?.name === 'NotFound' || x?.$metadata?.httpStatusCode === 404;
}

export interface S3ImageObjectStoreOptions {
  bucket: string;
  region: string;
  /** 로컬·CI의 moto 주소. 있으면 path-style과 시험 자격 증명을 쓴다 */
  endpoint?: string;
  /** SSE-KMS 키(운영). 없으면 버킷 기본 암호화를 쓴다 */
  kmsKeyId?: string;
  /** 시험에서 S3Client를 바꿔 끼울 때만 */
  client?: Pick<S3Client, 'send'>;
}

export class S3ImageObjectStore implements ImageObjectStore {
  readonly #client: Pick<S3Client, 'send'>;
  readonly #bucket: string;
  readonly #kmsKeyId: string | undefined;
  /** moto/로컬에서만 시험의 서명 없는 GET·HEAD를 위해 버킷 정책을 연다. 운영은 버킷 기본 비공개를 쓴다. */
  readonly #local: boolean;
  #localReady: Promise<void> | undefined;

  constructor(o: S3ImageObjectStoreOptions) {
    this.#bucket = o.bucket;
    this.#kmsKeyId = o.kmsKeyId;
    this.#local = o.endpoint !== undefined;
    this.#client =
      o.client ??
      new S3Client({
        region: o.region,
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' } } : {}),
      });
  }

  async #ensureLocalReadable(): Promise<void> {
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

  async putQuarantine(key: string, bytes: Uint8Array): Promise<void> {
    await this.#ensureLocalReadable();
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: checked(QUARANTINE, key),
        Body: bytes,
        CacheControl: PRIVATE_CACHE,
        ContentType: 'application/octet-stream',
        ...(this.#local ? { ACL: 'public-read' as const } : {}),
        ...(this.#kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.#kmsKeyId } : {}),
      }),
    );
  }

  async deleteQuarantine(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: checked(QUARANTINE, key) }));
  }

  async readStaging(key: string): Promise<Uint8Array | undefined> {
    try {
      const r = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: checked(STAGING, key) }));
      if (!r.Body) return undefined;
      return new Uint8Array(await r.Body.transformToByteArray());
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async stagingSize(key: string): Promise<number | undefined> {
    try {
      const r = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: checked(STAGING, key) }));
      return r.ContentLength;
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async deleteStaging(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: checked(STAGING, key) }));
  }

  async putPublic(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const k = checked(PUBLIC, key);
    const ext = k.slice(k.lastIndexOf('.') + 1);
    if (CONTENT_TYPES[ext] !== contentType) throw new Error('확장자와 Content-Type이 다른 공개 파생본');
    await this.#ensureLocalReadable();
    // 같은 공개 키는 덮어쓰지 않는다(immutable). IfNoneMatch/If-None-Match를 흉내 서버가 무시해도 막도록 먼저 HeadObject로 본다.
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: k }));
      throw new Error('이미 있는 공개 파생본');
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: k,
        Body: bytes,
        ContentType: contentType,
        CacheControl: PUBLIC_CACHE,
        ContentDisposition: `inline; filename="${k.split('/')[1]}.${ext}"`,
        ...(this.#local ? { ACL: 'public-read' as const } : {}),
        ...(this.#kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.#kmsKeyId } : {}),
      }),
    );
  }

  async deletePublic(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: checked(PUBLIC, key) }));
  }
}
