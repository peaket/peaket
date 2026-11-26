// F-04-14 증거 객체 저장소 S3 판(동결 로컬, LCH-290).
// 정본: docs/infra.md §9 '증거 버킷', docs/security/secrets-and-keys.md '증거 저장소 KMS 키'.
// Object Lock 법적 보존 ON·SSE-KMS로만 쓰고, 법적 보존 풀기·모든 판 지우기는 파기 정비(dispose)만 한다.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { EvidenceDisposer, EvidenceObjectStore, ExternalPostCaptures } from '../domain/ports.js';

const RETRY = { retryMode: 'standard' as const, maxAttempts: 3 };
const isNotFound = (e: unknown): boolean => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === 'NoSuchKey' || x?.name === 'NotFound' || x?.name === 'NoSuchBucket' || x?.$metadata?.httpStatusCode === 404;
};

export interface S3EvidenceObjectStoreOptions {
  bucket: string;
  kmsKeyId: string;
  region?: string;
  endpoint?: string;
  client?: Pick<S3Client, 'send'>;
}

export class S3EvidenceObjectStore implements EvidenceObjectStore {
  readonly kind = 'S3' as const;
  readonly #client: Pick<S3Client, 'send'>;
  readonly #bucket: string;
  readonly #kmsKeyId: string;

  constructor(o: S3EvidenceObjectStoreOptions) {
    if (!o.bucket) throw new Error('증거 버킷 이름이 없다');
    if (!o.kmsKeyId) throw new Error('증거 저장소 KMS 키 ID가 없다');
    this.#bucket = o.bucket;
    this.#kmsKeyId = o.kmsKeyId;
    this.#client =
      o.client ??
      new S3Client({
        region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
        ...RETRY,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
      });
  }

  async putOnce(key: string, bytes: Uint8Array, contentType: string): Promise<'CREATED' | 'SAME' | 'DIFFERENT'> {
    const existing = await this.get(key).catch(() => undefined);
    if (existing) return Buffer.from(existing).equals(Buffer.from(bytes)) ? 'SAME' : 'DIFFERENT';
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: Buffer.from(bytes),
          ContentLength: bytes.byteLength,
          ContentType: contentType,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.#kmsKeyId,
          ObjectLockLegalHoldStatus: 'ON',
          ChecksumAlgorithm: 'SHA256',
          IfNoneMatch: '*',
        }),
      );
      return 'CREATED';
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'PreconditionFailed' || name === '412') {
        const now = await this.get(key);
        if (!now) return 'DIFFERENT';
        return Buffer.from(now).equals(Buffer.from(bytes)) ? 'SAME' : 'DIFFERENT';
      }
      throw e;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      return out.Body ? new Uint8Array(await out.Body.transformToByteArray()) : undefined;
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async list(prefix: string): Promise<readonly { key: string; sizeBytes: number }[]> {
    const out = await this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix }));
    return (out.Contents ?? []).map((c) => ({ key: c.Key ?? '', sizeBytes: c.Size ?? 0 }));
  }

  async dispose(prefix: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await this.#client.send(new ListObjectVersionsCommand({ Bucket: this.#bucket, Prefix: prefix, ...(keyMarker ? { KeyMarker: keyMarker } : {}), ...(versionMarker ? { VersionIdMarker: versionMarker } : {}) }));
      for (const v of page.Versions ?? []) {
        if (!v.Key || !v.VersionId) continue;
        await this.#client.send(new PutObjectLegalHoldCommand({ Bucket: this.#bucket, Key: v.Key, VersionId: v.VersionId, LegalHold: { Status: 'OFF' } }));
        await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: v.Key, VersionId: v.VersionId }));
      }
      for (const m of page.DeleteMarkers ?? []) {
        if (!m.Key || !m.VersionId) continue;
        await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: m.Key, VersionId: m.VersionId }));
      }
      if (!page.IsTruncated) return;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  }
}

/** 법적 보존 풀기·판 지우기 전용. 운영 조립은 일반 저장소와 다른 신원의 클라이언트를 넘긴다(IR-09). */
export class S3EvidenceDisposer implements EvidenceDisposer {
  readonly #store: S3EvidenceObjectStore;
  readonly #quarantine?: string;
  readonly #client?: Pick<S3Client, 'send'>;
  constructor(o: S3EvidenceObjectStoreOptions & { quarantineBucket?: string }) {
    this.#store = new S3EvidenceObjectStore(o);
    this.#quarantine = o.quarantineBucket;
    this.#client =
      o.client ??
      (o.quarantineBucket
        ? new S3Client({
            region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
            ...RETRY,
            requestChecksumCalculation: 'WHEN_REQUIRED',
            ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
          })
        : undefined);
  }
  dispose(prefix: string): Promise<void> {
    return this.#store.dispose(prefix);
  }
  async disposeCapture(prefix: string): Promise<void> {
    await this.dispose(prefix);
    if (!this.#quarantine || !this.#client) return;
    const out = await this.#client.send(new ListObjectsV2Command({ Bucket: this.#quarantine, Prefix: prefix }));
    for (const c of out.Contents ?? []) {
      if (c.Key) await this.#client.send(new DeleteObjectCommand({ Bucket: this.#quarantine, Key: c.Key }));
    }
  }
}

export interface S3ExternalPostCapturesOptions {
  evidenceBucket: string;
  quarantineBucket?: string;
  kmsKeyId: string;
  region?: string;
  endpoint?: string;
  client?: Pick<S3Client, 'send'>;
}

/** 외부 게시물 캡처: 격리 버킷에 먼저 받고 CLEAN일 때 증거 버킷으로 옮긴다. 보기용 사본은 증거 버킷에 법적 보존 ON으로 둔다. */
export class S3ExternalPostCaptures implements ExternalPostCaptures {
  readonly #evidence: S3EvidenceObjectStore;
  readonly #client: Pick<S3Client, 'send'>;
  readonly #quarantine: string;
  readonly #kmsKeyId: string;

  constructor(o: S3ExternalPostCapturesOptions) {
    if (!o.quarantineBucket) throw new Error('외부 게시물 격리 버킷 이름이 없다');
    this.#evidence = new S3EvidenceObjectStore({ bucket: o.evidenceBucket, kmsKeyId: o.kmsKeyId, ...(o.region ? { region: o.region } : {}), ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(o.client ? { client: o.client } : {}) });
    this.#quarantine = o.quarantineBucket;
    this.#kmsKeyId = o.kmsKeyId;
    this.#client =
      o.client ??
      new S3Client({
        region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
        ...RETRY,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
      });
  }

  async putQuarantine(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.#client.send(new PutObjectCommand({ Bucket: this.#quarantine, Key: key, Body: Buffer.from(bytes), ContentLength: bytes.byteLength, ContentType: contentType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.#kmsKeyId, ChecksumAlgorithm: 'SHA256' }));
  }

  async promote(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.#evidence.putOnce(key, bytes, contentType);
  }

  async putView(key: string, bytes: Uint8Array): Promise<void> {
    await this.#evidence.putOnce(key, bytes, 'image/png');
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return (await this.#evidence.get(key)) ?? this.#getQuarantine(key);
  }

  async dispose(prefix: string): Promise<void> {
    await this.#evidence.dispose(prefix);
    await this.#disposeQuarantine(prefix);
  }

  async #getQuarantine(key: string): Promise<Uint8Array | undefined> {
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#quarantine, Key: key }));
      return out.Body ? new Uint8Array(await out.Body.transformToByteArray()) : undefined;
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async #disposeQuarantine(prefix: string): Promise<void> {
    const out = await this.#client.send(new ListObjectsV2Command({ Bucket: this.#quarantine, Prefix: prefix }));
    for (const c of out.Contents ?? []) {
      if (c.Key) await this.#client.send(new DeleteObjectCommand({ Bucket: this.#quarantine, Key: c.Key }));
    }
  }
}

// HeadObject는 운영 진단에만 쓴다(법적 보존·KMS 머리를 확인). 시험도 같은 머리를 본다.
export { HeadObjectCommand };
