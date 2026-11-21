// 공개 체크포인트의 게시 자리(ADR-0348 결정 6, ADR-0075 결정 6).
// 공개 게시 버킷(PEAKET_AUDIT_PUBLIC_BUCKET)과 감사 앵커 버킷(PEAKET_AUDIT_ANCHOR_BUCKET, BAT-355)에 같은 파일을 쓴다(둘 다 S3 Object Lock 컴플라이언스 7년).
// 체크포인트·서명·증명 파일은 한 번만 쓴다(putOnce): 이미 있으면 바이트가 같은지만 보고, 다르면 DIFFERENT(부르는 쪽이 SEV2로 멈춘다).
// 목록 index.json과 공개키 목록 public-keys.json은 새 판으로만 고친다(putVersion, 버킷 판 관리가 옛 판을 남긴다).
// local·ci는 흉내 S3(moto, 끝점 PEAKET_AUDIT_ANCHOR_S3_ENDPOINT)나 폴더(PEAKET_AUDIT_PUBLIC_DIR·PEAKET_AUDIT_ANCHOR_DIR), 그것도 없으면 메모리(경고)다.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** 공개 파일 보존 7년(Object Lock 컴플라이언스, ADR-0075 결정 6) */
export const AUDIT_PUBLIC_RETENTION_MS = 7 * 365 * 24 * 60 * 60_000;
/** 바뀌지 않는 파일과 짧게 캐시하는 목록 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const INDEX_CACHE = 'public, max-age=60';

export type PutOnceResult = 'CREATED' | 'SAME' | 'DIFFERENT';

/** 공개 게시 자리 하나 */
export interface AuditPublicStore {
  readonly kind: 'S3' | 'DIR' | 'MEMORY';
  /** 로그·경보에 쓰는 이름(public|anchor) */
  readonly name: string;
  get(key: string): Promise<Buffer | undefined>;
  /** 없으면 쓴다. 있으면 바이트를 견준다(덮어쓰지 않는다) */
  putOnce(key: string, body: Uint8Array, contentType: string, nowMs: number): Promise<PutOnceResult>;
  /** 새 판으로 쓴다(index.json·public-keys.json) */
  putVersion(key: string, body: Uint8Array, contentType: string, nowMs: number): Promise<void>;
}

const assertKey = (key: string): void => {
  if (!/^transparency\/v1\/[A-Za-z0-9._/-]+$/.test(key) || key.includes('..')) throw new Error(`공개 파일 이름이 틀렸다: ${key}`);
};

const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

/** S3 Object Lock 게시 자리(운영). 흉내 서버 주소는 local·ci만(설정이 거른다) */
export class S3AuditPublicStore implements AuditPublicStore {
  readonly kind = 'S3' as const;
  readonly #client: Pick<S3Client, 'send'>;

  constructor(
    readonly name: string,
    private readonly o: { bucket: string; region?: string; endpoint?: string; client?: Pick<S3Client, 'send'> },
  ) {
    if (!o.bucket) throw new Error('공개 게시 버킷 이름이 없다');
    this.#client =
      o.client ??
      new S3Client({
        region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
        retryMode: 'standard',
        maxAttempts: 3,
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
      });
  }

  async get(key: string): Promise<Buffer | undefined> {
    assertKey(key);
    try {
      const r = await this.#client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : Buffer.alloc(0);
    } catch (e) {
      const n = errorName(e);
      if (n === 'NoSuchKey' || n === 'NotFound') return undefined;
      throw e;
    }
  }

  async putOnce(key: string, body: Uint8Array, contentType: string, nowMs: number): Promise<PutOnceResult> {
    assertKey(key);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.o.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: IMMUTABLE_CACHE,
          IfNoneMatch: '*',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: new Date(nowMs + AUDIT_PUBLIC_RETENTION_MS),
          ChecksumAlgorithm: 'SHA256',
        }),
      );
      return 'CREATED';
    } catch (e) {
      const n = errorName(e);
      const status = (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
      // 같은 이름이 이미 있다(조건부 쓰기 412, 동시 쓰기 409): 바이트를 견준다
      if (n !== 'PreconditionFailed' && status !== 412 && status !== 409) throw e;
      const have = await this.get(key);
      return have !== undefined && have.equals(Buffer.from(body)) ? 'SAME' : 'DIFFERENT';
    }
  }

  async putVersion(key: string, body: Uint8Array, contentType: string, nowMs: number): Promise<void> {
    assertKey(key);
    void nowMs;
    // 보존은 버킷 기본값(Object Lock)이 판마다 건다. 목록은 짧게 캐시한다
    await this.#client.send(new PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: INDEX_CACHE, ChecksumAlgorithm: 'SHA256' }));
  }
}

/** 폴더 게시 자리(local·ci). 같은 이름이 있으면 덮지 않고 견준다 */
export class DirAuditPublicStore implements AuditPublicStore {
  readonly kind = 'DIR' as const;
  readonly #root: string;

  constructor(
    readonly name: string,
    dir: string,
  ) {
    this.#root = resolve(dir);
  }

  #path(key: string): string {
    assertKey(key);
    const p = resolve(join(this.#root, ...key.split('/')));
    if (!p.startsWith(this.#root + sep)) throw new Error(`공개 파일 이름이 폴더 밖이다: ${key}`);
    return p;
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.#path(key));
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async putOnce(key: string, body: Uint8Array): Promise<PutOnceResult> {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true });
    try {
      await writeFile(p, body, { flag: 'wx' });
      return 'CREATED';
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'EEXIST') throw e;
      const have = await readFile(p);
      return have.equals(Buffer.from(body)) ? 'SAME' : 'DIFFERENT';
    }
  }

  async putVersion(key: string, body: Uint8Array): Promise<void> {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, p);
  }
}

/** 메모리 게시 자리(시험). failNext만큼 쓰기를 실패시킨다 */
export class MemoryAuditPublicStore implements AuditPublicStore {
  readonly kind = 'MEMORY' as const;
  readonly objects = new Map<string, Buffer>();
  /** putVersion으로 쓴 판(이름마다 차례) */
  readonly versions = new Map<string, Buffer[]>();
  failNext = 0;

  constructor(readonly name = 'memory') {}

  #maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('memory-public-put-failed');
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    assertKey(key);
    const v = this.objects.get(key);
    return v ? Buffer.from(v) : undefined;
  }

  async putOnce(key: string, body: Uint8Array): Promise<PutOnceResult> {
    assertKey(key);
    this.#maybeFail();
    const have = this.objects.get(key);
    if (have) return have.equals(Buffer.from(body)) ? 'SAME' : 'DIFFERENT';
    this.objects.set(key, Buffer.from(body));
    return 'CREATED';
  }

  async putVersion(key: string, body: Uint8Array): Promise<void> {
    assertKey(key);
    this.#maybeFail();
    this.objects.set(key, Buffer.from(body));
    this.versions.set(key, [...(this.versions.get(key) ?? []), Buffer.from(body)]);
  }
}
