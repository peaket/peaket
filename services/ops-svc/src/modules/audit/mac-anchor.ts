// 감사 체인 mac의 5분 앵커(ADR-0341 결정 5, ADR-0053 결정 12). mac_seq가 마지막 앵커보다 크면 {v, seq, mac(16진), keyId, at}를
// 감사 앵커 버킷 객체 audit-chain/anchors/v1/{seq 20자리}.json에 쓴다(S3 Object Lock 컴플라이언스 7년). 쓴 뒤 audit_mac_anchor에 남겨 다음 바퀴가 겹쳐 쓰지 않게 하고,
// 행을 넣다 실패하면 다음 바퀴가 같은 이름으로 다시 쓴다. local·ci·demo는 폴더나 메모리에 쓴다(경고 한 줄).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const MAC_ANCHOR_PREFIX = 'audit-chain/anchors/v1/';
/** 앵커 객체 보존 기간 7년(Object Lock 컴플라이언스) */
export const MAC_ANCHOR_RETENTION_MS = 7 * 365 * 24 * 60 * 60_000;
/** 앵커 간격 5분 [가정] */
export const MAC_ANCHOR_INTERVAL_MS = 5 * 60_000;

/** 앵커 객체 한 개의 본문 */
export interface MacAnchor {
  readonly v: 1;
  readonly seq: number;
  /** 그 seq 행의 mac(16진) */
  readonly mac: string;
  readonly keyId: string;
  /** 쓴 시각(ISO) */
  readonly at: string;
}

export const macAnchorObjectKey = (seq: number): string => `${MAC_ANCHOR_PREFIX}${String(seq).padStart(20, '0')}.json`;

const parseAnchor = (text: string): MacAnchor | undefined => {
  try {
    const v = JSON.parse(text) as Partial<MacAnchor>;
    if (v.v !== 1 || typeof v.seq !== 'number' || typeof v.mac !== 'string' || typeof v.keyId !== 'string' || typeof v.at !== 'string') return undefined;
    return v as MacAnchor;
  } catch {
    return undefined;
  }
};

/** 감사 앵커 저장소. durable이 참이면 검증 잡이 이 저장소의 객체를 앵커의 원본으로 읽는다(DB 행은 고칠 수 있다) */
export interface MacAnchorStore {
  readonly kind: 'S3' | 'DIR' | 'MEMORY';
  readonly durable: boolean;
  put(anchor: MacAnchor, nowMs: number): Promise<string>;
  /** seq가 from 이상 to 이하인 앵커(seq 차례). 읽지 못한 객체는 빼지 않고 던진다 */
  list(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]>;
}

/** S3 Object Lock 앵커(운영). 흉내 서버 주소는 local·ci만(moto) */
export class S3MacAnchorStore implements MacAnchorStore {
  readonly kind = 'S3' as const;
  readonly durable = true;
  readonly #client: Pick<S3Client, 'send'>;

  constructor(private readonly o: { bucket: string; region?: string; endpoint?: string; client?: Pick<S3Client, 'send'> }) {
    if (!o.bucket) throw new Error('감사 앵커 버킷 이름이 없다');
    this.#client =
      o.client ??
      new S3Client({
        region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
        retryMode: 'standard',
        maxAttempts: 3,
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
      });
  }

  async put(anchor: MacAnchor, nowMs: number): Promise<string> {
    const key = macAnchorObjectKey(anchor.seq);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.o.bucket,
        Key: key,
        Body: JSON.stringify(anchor),
        ContentType: 'application/json',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(nowMs + MAC_ANCHOR_RETENTION_MS),
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    return key;
  }

  async list(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]> {
    const out: MacAnchor[] = [];
    let token: string | undefined;
    const startAfter = fromSeq > 1 ? macAnchorObjectKey(fromSeq - 1) : undefined;
    do {
      const page = await this.#client.send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: MAC_ANCHOR_PREFIX, ...(startAfter && !token ? { StartAfter: startAfter } : {}), ...(token ? { ContinuationToken: token } : {}) }));
      for (const obj of page.Contents ?? []) {
        const seq = Number(obj.Key?.slice(MAC_ANCHOR_PREFIX.length, -'.json'.length));
        if (!Number.isSafeInteger(seq) || seq < fromSeq) continue;
        if (seq > toSeq) return out;
        const body = await this.#client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: obj.Key }));
        const anchor = parseAnchor((await body.Body?.transformToString('utf8')) ?? '');
        if (!anchor || anchor.seq !== seq) throw new Error(`감사 앵커 객체를 읽지 못했다: seq ${seq}`);
        out.push(anchor);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

/** 폴더 앵커(local·ci·demo). 같은 이름이 있으면 덮어쓴다(같은 seq·mac이다) */
export class DirMacAnchorStore implements MacAnchorStore {
  readonly kind = 'DIR' as const;
  readonly durable = true;

  constructor(private readonly dir: string) {}

  async put(anchor: MacAnchor): Promise<string> {
    const key = macAnchorObjectKey(anchor.seq);
    const path = join(this.dir, key);
    await mkdir(join(this.dir, MAC_ANCHOR_PREFIX), { recursive: true });
    await writeFile(path, JSON.stringify(anchor), 'utf8');
    return key;
  }

  async list(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, MAC_ANCHOR_PREFIX));
    } catch {
      return [];
    }
    const out: MacAnchor[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const seq = Number(name.slice(0, -'.json'.length));
      if (!Number.isSafeInteger(seq) || seq < fromSeq || seq > toSeq) continue;
      const anchor = parseAnchor(await readFile(join(this.dir, MAC_ANCHOR_PREFIX, name), 'utf8'));
      if (!anchor || anchor.seq !== seq) throw new Error(`감사 앵커 파일을 읽지 못했다: seq ${seq}`);
      out.push(anchor);
    }
    return out;
  }
}

/** 메모리 앵커(시험·버킷도 폴더도 없는 local). 프로세스 밖에서 읽을 수 없어 검증 잡은 DB 행을 본다 */
export class MemoryMacAnchorStore implements MacAnchorStore {
  readonly kind = 'MEMORY' as const;
  readonly durable = false;
  readonly objects = new Map<string, MacAnchor>();
  /** 시험이 쓰기 실패를 흉내 낸다 */
  failNext = 0;

  async put(anchor: MacAnchor): Promise<string> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('memory-anchor-put-failed');
    }
    const key = macAnchorObjectKey(anchor.seq);
    this.objects.set(key, anchor);
    return key;
  }

  async list(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]> {
    return [...this.objects.values()].filter((a) => a.seq >= fromSeq && a.seq <= toSeq).sort((a, b) => a.seq - b.seq);
  }
}

/** 앵커가 기대는 mac 머리와 앵커 행(audit_mac_anchor) */
export interface MacAnchorLedger {
  /** mac을 채운 마지막 seq와 그 mac(같은 읽기로) */
  macHead(): Promise<{ readonly macSeq: number; readonly lastMac: Buffer }>;
  /** 마지막 앵커 seq(없으면 0) */
  lastAnchorSeq(): Promise<number>;
  /** 앵커 행을 넣는다(같은 seq가 있으면 그대로) */
  recordAnchor(a: { readonly seq: number; readonly mac: Buffer; readonly objectKey: string; readonly keyId: string; readonly nowMs: number }): Promise<void>;
  /** seq가 from 이상 to 이하인 앵커 행(seq 차례) */
  anchorsBetween(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]>;
}

/** 5분 앵커 한 바퀴. mac_seq가 늘었을 때만 객체 하나를 쓰고, 쓰기에 실패하면 행을 남기지 않는다(다음 바퀴에 다시) */
export class AuditMacAnchorer {
  constructor(
    private readonly ledger: MacAnchorLedger,
    private readonly store: MacAnchorStore,
    private readonly keyId: string,
  ) {}

  async runOnce(nowMs: number): Promise<{ readonly anchoredSeq?: number; readonly error?: string }> {
    const head = await this.ledger.macHead();
    if (head.macSeq <= 0 || head.macSeq <= (await this.ledger.lastAnchorSeq())) return {};
    const anchor: MacAnchor = { v: 1, seq: head.macSeq, mac: head.lastMac.toString('hex'), keyId: this.keyId, at: new Date(nowMs).toISOString() };
    let objectKey: string;
    try {
      objectKey = await this.store.put(anchor, nowMs);
    } catch (e) {
      return { error: e instanceof Error ? e.name : 'anchor-put-failed' };
    }
    await this.ledger.recordAnchor({ seq: anchor.seq, mac: head.lastMac, objectKey, keyId: this.keyId, nowMs });
    return { anchoredSeq: anchor.seq };
  }
}
