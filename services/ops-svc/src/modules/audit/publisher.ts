// 게시 작업 audit-anchor의 한 실행(ADR-0348 결정 1·5·6·9·10, ADR-0075 결정 3~6·9). 진입점은 jobs/audit-anchor.ts다.
// 한 실행의 차례:
//  ① 서명 키 공개키를 audit_signing_key에 둔다(KMS GetPublicKey, 같은 키 ID에 다른 키면 멈춘다).
//  ② 만들 때가 된 체크포인트를 만든다: 회차 마감(판매 시작 + 60분이 지난 회차, 같은 실행의 회차는 하나로) → 일(그날 00:10 KST 뒤 첫 실행, 00:09:59.999에는 없음).
//     공개 사슬 마지막 행 뒤 기록을 덮는다. 새 기록이 없으면 만들지 않고 다음 실행에서 다시 본다(빈 트리는 쓰지 않는다). 이 행은 감사 체인에 기록을 더하지 않는다.
//     끝난 회차 목록을 읽지 못하면 그 실행의 회차 마감 체크포인트만 미룬다(일 체크포인트는 그대로).
//  ③ 서명 전 행을 번호 차례로: 체인을 다시 모은 루트·JSON·직전 해시가 저장값과 같을 때만 서명한다. 다르면 서명·게시하지 않고 SEV2 로그 audit-checkpoint-mismatch를 남기고
//     그 뒤 번호도 멈춘다(경보·AUDIT_CHAIN_MISMATCH 기록은 ops-svc 프로세스의 신호 바퀴가 같은 검증으로 낸다, checkpoint-signals.ts. 이 작업의 DB 역할은 체인·경보를 쓰지 못한다).
//  ④ 서명한 행에 공개 타임스탬프를 찍는다(캘린더 하나라도 받으면 PENDING, 모두 실패하면 행을 그대로 두고 다음 실행에서 다시).
//  ⑤ 번호 차례로 게시한다: 두 자리(공개 게시 버킷·감사 앵커 버킷)에 같은 바이트를 쓰고, 둘 다 된 뒤에만 published_at을 적는다. 앞 번호가 게시되지 않았으면 멈춘다.
//     같은 이름에 다른 바이트가 있으면 SEV2 로그 audit-public-file-conflict로 멈춘다.
//  ⑥ PENDING 증명을 1시간 [가정]마다 캘린더에서 다시 받아 비트코인 증명이 붙으면 <번호>.complete.ots를 두 자리에 쓰고 COMPLETE로 바꾼다(.ots는 덮지 않는다).
// 게시 파일(transparency/v1/ 아래):
//   checkpoints/<번호 10자리 0채움>.json   체크포인트 JSON 글(UTF-8, checkpoint_json 그대로)
//   checkpoints/<번호>.sig                  서명 DER의 base64 글(줄바꿈 없음)
//   checkpoints/<번호>.ots                  대기 증명 파일(OpenTimestamps 꼴, ots.ts)
//   checkpoints/<번호>.complete.ots         완료 증명 파일(비트코인 증명이 붙은 뒤)
//   public-keys.json                        {"version":1,"keys":[{"keyId","alg":"ECDSA_P256_SHA256","publicKeyPem","firstUsedAt"}]}(키 ID 차례, 새 판으로만)
//   index.json                              {"version":1,"checkpoints":[{"no","checkpointHash","json","sig","ots","completeOts"?}]}(번호 차례, 게시한 것만, 새 판으로만)
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbTransaction } from '@peaket/platform';
import {
  buildPublicCheckpoint,
  checkpointMerkleRoot,
  CheckpointRaceLost,
  CHECKPOINT_COLUMNS,
  DrizzleAuditCheckpointStore,
  isPublicCheckpoint,
  MemoryAuditCheckpointStore,
  toCheckpoint,
  type AuditChainReader,
  type AuditCheckpoint,
  type AuditSigningKey,
  type ClosedEvent,
  type NewAuditCheckpoint,
  type OtsState,
} from './checkpoint.js';
import { checkpointHashOf, parseCheckpointJson } from './checkpoint-json.js';
import { CHECKPOINT_SIGNATURE_ALG, spkiPem, verifyCheckpointSignature, type CheckpointSigner } from './checkpoint-signer.js';
import { OTS_UPGRADE_INTERVAL_MS, stampDigest, upgradeProof, type OpenTimestampsCalendar } from './ots.js';
import type { AuditPublicStore } from './public-store.js';

export const TRANSPARENCY_PREFIX = 'transparency/v1/';
export const checkpointFileBase = (no: number): string => `${TRANSPARENCY_PREFIX}checkpoints/${String(no).padStart(10, '0')}`;
export const PUBLIC_KEYS_FILE = `${TRANSPARENCY_PREFIX}public-keys.json`;
export const INDEX_FILE = `${TRANSPARENCY_PREFIX}index.json`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KST_OFFSET_MS = 9 * HOUR;
/** ADR-0348 결정 9·5의 시간 값 [가정] */
export const AUDIT_ANCHOR_SCHEDULE = Object.freeze({
  /** 일 체크포인트: 그날 00:10 KST */
  dailyAfterKstMs: 10 * MINUTE,
  /** 회차 마감: 판매 시작 + 60분(온세일 윈도우 끝) */
  onsaleWindowEndMs: 60 * MINUTE,
  /** 끝난 회차 목록 한 번 읽는 구간 상한(하루) */
  closedLookbackMs: DAY,
  /** 이미 묶은 회차를 찾는 뒤돌아보기(구간 상한의 두 배) */
  closedDedupMs: 2 * DAY,
  /** 대기 증명 다시 받기 */
  upgradeIntervalMs: OTS_UPGRADE_INTERVAL_MS,
  /** 한 실행이 단계마다 다루는 행 */
  batch: 100,
});
/** 작업이 만든 행의 actor_ref(관리 계정 ID를 적지 않는다) */
export const AUDIT_ANCHOR_ACTOR = 'audit-anchor';

/** 그날 KST 0시(UTC ms) */
export const kstDayStartMs = (ms: number): number => Math.floor((ms + KST_OFFSET_MS) / DAY) * DAY - KST_OFFSET_MS;
/** KST 날짜 'YYYY-MM-DD' */
export const kstDate = (ms: number): string => new Date(kstDayStartMs(ms) + KST_OFFSET_MS).toISOString().slice(0, 10);

/** 끝난 온세일 회차 목록(core-svc GET /internal/v1/events/onsale-closed). 못 읽으면 던진다 */
export interface ClosedOnsaleSource {
  /** 판매 시작 + 60분이 [fromMs, toMs)에 든 회차의 ID·마감 시각(구간 하루 이하) */
  closedBetween(fromMs: number, toMs: number): Promise<readonly ClosedEvent[]>;
}

/** 법정 접속기록 일 앵커(OPS-330, BAT-395). 그 저장소가 생기기 전에는 조립하지 않아 칸을 뺀다 */
export interface AccessLogDayAnchorSource {
  /** 그날(KST 'YYYY-MM-DD')의 일 앵커(16진 64자). 없으면 undefined */
  dayAnchor(kstDate: string): Promise<string | undefined>;
}

/** 게시 작업의 저장 면(DB 역할 ops_audit_anchor: audit_checkpoint·audit_signing_key 쓰기만) */
export interface AuditPublishStore {
  lastPublic(): Promise<AuditCheckpoint | undefined>;
  findByNo(no: number): Promise<AuditCheckpoint | undefined>;
  /** 공개 행을 쓴다(번호 잠금 안에서 이어지는지 보고, 아니면 CheckpointRaceLost) */
  create(input: NewAuditCheckpoint): Promise<AuditCheckpoint>;
  /** created_at이 sinceMs 이상인 DAILY 행이 있는가 */
  dailySince(sinceMs: number): Promise<boolean>;
  /** created_at이 sinceMs 이상인 EVENT_CLOSE 행이 묶은 회차 */
  closedEventsSince(sinceMs: number): Promise<readonly ClosedEvent[]>;
  /** 서명 전 공개 행(번호 차례) */
  unsignedPublic(limit: number): Promise<readonly AuditCheckpoint[]>;
  /** 서명이 비었을 때만 채운다 */
  saveSignature(checkpointId: string, signature: string, keyId: string): Promise<boolean>;
  /** 서명했지만 증명 파일이 없는 행(번호 차례) */
  unstamped(limit: number): Promise<readonly AuditCheckpoint[]>;
  /** 증명 상태·파일·다시 받은 시각. state·proof가 없으면 그대로 둔다 */
  saveOts(checkpointId: string, o: { readonly state?: OtsState; readonly proof?: Buffer; readonly upgradedAtMs: number }): Promise<void>;
  /** 서명·증명은 있지만 게시하지 않은 행(번호 차례) */
  unpublished(limit: number): Promise<readonly AuditCheckpoint[]>;
  /** 게시 시각이 비었을 때만 적는다 */
  markPublished(checkpointId: string, anchorRef: string, nowMs: number): Promise<boolean>;
  /** 게시했고 PENDING이며 마지막으로 다시 받은 때가 dueBeforeMs 이하인 행(번호 차례) */
  pendingOts(dueBeforeMs: number, limit: number): Promise<readonly AuditCheckpoint[]>;
  /** 키 행을 넣는다. 같은 키 ID에 다른 공개키가 있으면 던진다 */
  putSigningKey(key: { readonly keyId: string; readonly publicKeySpki: Buffer; readonly alg: string; readonly nowMs: number }): Promise<void>;
  signingKeys(): Promise<readonly AuditSigningKey[]>;
  /** 게시한 행의 목록(번호 차례) */
  publishedIndex(): Promise<readonly { readonly no: number; readonly checkpointHash: string; readonly complete: boolean }[]>;
}

const conflictingKey = (keyId: string): Error => new Error(`audit_signing_key ${keyId}에 다른 공개키가 이미 있다(키 ID를 다시 쓰지 않는다)`);

/** 메모리 게시 저장 면(시험). API의 메모리 체크포인트 저장소와 같은 행을 본다 */
export class MemoryAuditPublishStore extends MemoryAuditCheckpointStore implements AuditPublishStore {
  async dailySince(sinceMs: number): Promise<boolean> {
    return this.entries.some((c) => c.kind === 'DAILY' && c.createdAtMs >= sinceMs);
  }
  async closedEventsSince(sinceMs: number): Promise<readonly ClosedEvent[]> {
    return this.entries.filter((c) => c.kind === 'EVENT_CLOSE' && c.createdAtMs >= sinceMs).flatMap((c) => c.closedEvents ?? []);
  }
  #publicSorted(): AuditCheckpoint[] {
    return this.entries.filter((c) => c.no !== undefined).sort((a, b) => a.no! - b.no!);
  }
  async saveSignature(checkpointId: string, signature: string, keyId: string): Promise<boolean> {
    const c = await this.find(checkpointId);
    if (!c || c.signature !== undefined) return false;
    this.patch(checkpointId, { signature, keyId });
    return true;
  }
  async unstamped(limit: number): Promise<readonly AuditCheckpoint[]> {
    return this.#publicSorted().filter((c) => c.signature !== undefined && c.otsState === undefined).slice(0, limit);
  }
  async saveOts(checkpointId: string, o: { state?: OtsState; proof?: Buffer; upgradedAtMs: number }): Promise<void> {
    this.patch(checkpointId, { ...(o.state ? { otsState: o.state } : {}), ...(o.proof ? { otsProof: Buffer.from(o.proof) } : {}), otsUpgradedAtMs: o.upgradedAtMs });
  }
  async unpublished(limit: number): Promise<readonly AuditCheckpoint[]> {
    return this.#publicSorted().filter((c) => c.signature !== undefined && c.otsState !== undefined && c.publishedAtMs === undefined).slice(0, limit);
  }
  async markPublished(checkpointId: string, anchorRef: string, nowMs: number): Promise<boolean> {
    const c = await this.find(checkpointId);
    if (!c || c.publishedAtMs !== undefined) return false;
    this.patch(checkpointId, { publishedAtMs: nowMs, anchorRef, anchoredAtMs: nowMs });
    return true;
  }
  async pendingOts(dueBeforeMs: number, limit: number): Promise<readonly AuditCheckpoint[]> {
    return this.#publicSorted()
      .filter((c) => c.otsState === 'PENDING' && c.publishedAtMs !== undefined && (c.otsUpgradedAtMs ?? 0) <= dueBeforeMs)
      .slice(0, limit);
  }
  async putSigningKey(key: { keyId: string; publicKeySpki: Buffer; alg: string; nowMs: number }): Promise<void> {
    const have = this.keys.get(key.keyId);
    if (have) {
      if (!have.publicKeySpki.equals(key.publicKeySpki)) throw conflictingKey(key.keyId);
      return;
    }
    this.keys.set(key.keyId, { keyId: key.keyId, publicKeySpki: Buffer.from(key.publicKeySpki), alg: key.alg, firstUsedAtMs: key.nowMs });
  }
  async signingKeys(): Promise<readonly AuditSigningKey[]> {
    return [...this.keys.values()].sort((a, b) => a.keyId.localeCompare(b.keyId));
  }
  async publishedIndex(): Promise<readonly { no: number; checkpointHash: string; complete: boolean }[]> {
    return this.#publicSorted()
      .filter((c) => c.publishedAtMs !== undefined && c.checkpointHash !== undefined)
      .map((c) => ({ no: c.no!, checkpointHash: c.checkpointHash!, complete: c.otsState === 'COMPLETE' }));
  }
}

type Rows = { rows: unknown[] };
const rowsOf = async (q: Promise<Rows>): Promise<AuditCheckpoint[]> => ((await q).rows as Parameters<typeof toCheckpoint>[0][]).map(toCheckpoint);

/** PostgreSQL 게시 저장 면. 작업은 ops_audit_anchor 역할로 붙는다 */
export class DrizzleAuditPublishStore extends DrizzleAuditCheckpointStore implements AuditPublishStore {
  async dailySince(sinceMs: number): Promise<boolean> {
    const r = await this.database.db.execute(sql`select 1 from audit_checkpoint where kind = 'DAILY' and created_at >= ${new Date(sinceMs)}::timestamptz limit 1`);
    return r.rows.length > 0;
  }
  async closedEventsSince(sinceMs: number): Promise<readonly ClosedEvent[]> {
    const rows = await rowsOf(this.database.db.execute(sql`select ${CHECKPOINT_COLUMNS} from audit_checkpoint where kind = 'EVENT_CLOSE' and created_at >= ${new Date(sinceMs)}::timestamptz`));
    return rows.flatMap((c) => c.closedEvents ?? []);
  }
  async saveSignature(checkpointId: string, signature: string, keyId: string): Promise<boolean> {
    const r = await this.database.db.execute(sql`update audit_checkpoint set signature = ${signature}, key_id = ${keyId} where id = ${checkpointId}::uuid and no is not null and signature is null returning id`);
    return r.rows.length === 1;
  }
  unstamped(limit: number): Promise<readonly AuditCheckpoint[]> {
    return rowsOf(this.database.db.execute(sql`select ${CHECKPOINT_COLUMNS} from audit_checkpoint where no is not null and signature is not null and ots_state is null order by no limit ${limit}`));
  }
  async saveOts(checkpointId: string, o: { state?: OtsState; proof?: Buffer; upgradedAtMs: number }): Promise<void> {
    await this.database.db.execute(sql`
      update audit_checkpoint set ots_state = coalesce(${o.state ?? null}::text, ots_state), ots_proof = coalesce(${o.proof ?? null}::bytea, ots_proof),
             ots_upgraded_at = ${new Date(o.upgradedAtMs)}::timestamptz
      where id = ${checkpointId}::uuid and no is not null`);
  }
  unpublished(limit: number): Promise<readonly AuditCheckpoint[]> {
    return rowsOf(
      this.database.db.execute(sql`select ${CHECKPOINT_COLUMNS} from audit_checkpoint where no is not null and signature is not null and ots_state is not null and published_at is null order by no limit ${limit}`),
    );
  }
  async markPublished(checkpointId: string, anchorRef: string, nowMs: number): Promise<boolean> {
    const at = new Date(nowMs);
    const r = await this.database.db.execute(sql`
      update audit_checkpoint set published_at = ${at}::timestamptz, anchor_ref = ${anchorRef}, anchored_at = ${at}::timestamptz
      where id = ${checkpointId}::uuid and published_at is null returning id`);
    return r.rows.length === 1;
  }
  pendingOts(dueBeforeMs: number, limit: number): Promise<readonly AuditCheckpoint[]> {
    return rowsOf(
      this.database.db.execute(sql`
        select ${CHECKPOINT_COLUMNS} from audit_checkpoint
        where ots_state = 'PENDING' and published_at is not null and (ots_upgraded_at is null or ots_upgraded_at <= ${new Date(dueBeforeMs)}::timestamptz)
        order by no limit ${limit}`),
    );
  }
  async putSigningKey(key: { keyId: string; publicKeySpki: Buffer; alg: string; nowMs: number }): Promise<void> {
    await this.database.transaction(async (tx: DbTransaction) => {
      await tx.execute(sql`
        insert into audit_signing_key (key_id, public_key_spki, alg, first_used_at) values (${key.keyId}, ${key.publicKeySpki}, ${key.alg}, ${new Date(key.nowMs)}::timestamptz)
        on conflict (key_id) do nothing`);
      const [row] = (await tx.execute(sql`select public_key_spki from audit_signing_key where key_id = ${key.keyId}`)).rows as { public_key_spki: Buffer }[];
      if (!row || !Buffer.from(row.public_key_spki).equals(key.publicKeySpki)) throw conflictingKey(key.keyId);
    });
  }
  async signingKeys(): Promise<readonly AuditSigningKey[]> {
    const rows = (await this.database.db.execute(sql`select key_id, public_key_spki, alg, first_used_at from audit_signing_key order by key_id`)).rows as {
      key_id: string;
      public_key_spki: Buffer;
      alg: string;
      first_used_at: Date | string;
    }[];
    return rows.map((r) => ({ keyId: r.key_id, publicKeySpki: Buffer.from(r.public_key_spki), alg: r.alg, firstUsedAtMs: new Date(r.first_used_at).getTime() }));
  }
  async publishedIndex(): Promise<readonly { no: number; checkpointHash: string; complete: boolean }[]> {
    const rows = (
      await this.database.db.execute(sql`select no, encode(checkpoint_hash, 'hex') as checkpoint_hash, ots_state from audit_checkpoint where published_at is not null and no is not null order by no`)
    ).rows as { no: number | string; checkpoint_hash: string; ots_state: string | null }[];
    return rows.map((r) => ({ no: Number(r.no), checkpointHash: r.checkpoint_hash, complete: r.ots_state === 'COMPLETE' }));
  }
}

export type AuditAnchorLog = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => void;

export interface AuditCheckpointPublisherDeps {
  readonly store: AuditPublishStore;
  readonly chain: Pick<AuditChainReader, 'headSeq' | 'entriesBetween'>;
  readonly signer: CheckpointSigner;
  readonly calendars: readonly OpenTimestampsCalendar[];
  /** 공개 게시 버킷과 감사 앵커 버킷(둘 다 써야 게시한 것이다) */
  readonly targets: readonly AuditPublicStore[];
  readonly closed?: ClosedOnsaleSource;
  readonly dayAnchors?: AccessLogDayAnchorSource;
  readonly log?: AuditAnchorLog;
}

export interface AuditAnchorRunResult {
  readonly created: readonly { readonly no: number; readonly kind: string }[];
  readonly signed: number;
  readonly stamped: number;
  readonly published: number;
  readonly completed: number;
  /** 루트·JSON·직전 해시가 저장값과 다른 체크포인트 번호(SEV2) */
  readonly mismatches: readonly number[];
  /** 같은 이름의 다른 바이트(SEV2) */
  readonly conflicts: readonly string[];
  /** 다시 할 실패(캘린더·KMS·버킷·core) */
  readonly errors: readonly string[];
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** 게시 작업 한 실행. 실행 사이에 상태는 DB 행에만 있다(겹쳐 돌지 않게 진입점이 잠근다) */
export class AuditCheckpointPublisher {
  constructor(private readonly deps: AuditCheckpointPublisherDeps) {
    if (deps.targets.length === 0) throw new Error('게시 자리가 없다(공개 게시 버킷·감사 앵커 버킷)');
  }

  #log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string): void {
    this.deps.log?.(level, fields, msg);
  }

  async run(nowMs: number): Promise<AuditAnchorRunResult> {
    const errors: string[] = [];
    const mismatches: number[] = [];
    const conflicts: string[] = [];
    let spki: Buffer | undefined;
    try {
      spki = await this.deps.signer.publicKeySpki();
      await this.deps.store.putSigningKey({ keyId: this.deps.signer.keyId, publicKeySpki: spki, alg: CHECKPOINT_SIGNATURE_ALG, nowMs });
    } catch (e) {
      // 다른 키 재료가 같은 키 ID로 오면 멈춘다(서명을 섞지 않는다). KMS 장애는 다음 실행에서 다시
      if (e instanceof Error && e.message.startsWith('audit_signing_key')) throw e;
      spki = undefined;
      errors.push(`signing-key:${errName(e)}`);
      this.#log('warn', { event: 'audit-checkpoint-key-unavailable', err: errName(e) }, '서명 키 공개키를 받지 못해 이번 실행은 서명하지 않는다');
    }
    const created = await this.#createDue(nowMs, errors);
    const signed = spki ? await this.#sign(spki, mismatches, errors) : 0;
    const stamped = await this.#stamp(nowMs, errors);
    const published = await this.#publish(nowMs, conflicts, errors);
    const completed = await this.#upgrade(nowMs, conflicts, errors);
    return { created, signed, stamped, published, completed, mismatches, conflicts, errors };
  }

  async #createPublic(kind: 'DAILY' | 'EVENT_CLOSE', nowMs: number, extra: { reason: string; closedEvents?: readonly ClosedEvent[]; accessLogDayAnchor?: string }): Promise<AuditCheckpoint | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = await this.deps.store.lastPublic();
      const fromSeq = (last?.toSeq ?? 0) + 1;
      const toSeq = await this.deps.chain.headSeq();
      if (toSeq < fromSeq) return undefined;
      const entries = await this.deps.chain.entriesBetween(fromSeq, toSeq);
      const no = (last?.no ?? 0) + 1;
      const prevCheckpointHash = last?.checkpointHash ?? '';
      const built = buildPublicCheckpoint(entries, {
        no,
        fromSeq,
        toSeq,
        prevCheckpointHash,
        createdAtMs: nowMs,
        ...(extra.accessLogDayAnchor !== undefined ? { accessLogDayAnchor: extra.accessLogDayAnchor } : {}),
        ...(extra.closedEvents !== undefined ? { closedEventIds: extra.closedEvents.map((e) => e.eventId) } : {}),
      });
      try {
        return await this.deps.store.create({
          checkpointId: randomUUID(),
          fromSeq,
          toSeq,
          rootHash: built.rootHash,
          prevCheckpointHash,
          reason: extra.reason,
          actorRef: AUDIT_ANCHOR_ACTOR,
          nowMs,
          kind,
          no,
          leafCount: built.leafCount,
          checkpointJson: built.checkpointJson,
          checkpointHash: built.checkpointHash,
          ...(extra.accessLogDayAnchor !== undefined ? { accessLogDayAnchor: extra.accessLogDayAnchor } : {}),
          ...(extra.closedEvents !== undefined ? { closedEvents: extra.closedEvents } : {}),
        });
      } catch (e) {
        if (!(e instanceof CheckpointRaceLost)) throw e;
      }
    }
    throw new Error('공개 체크포인트 번호를 세 번 다투어 잃었다');
  }

  async #createDue(nowMs: number, errors: string[]): Promise<{ no: number; kind: string }[]> {
    const out: { no: number; kind: string }[] = [];
    const s = AUDIT_ANCHOR_SCHEDULE;
    // 회차 마감: 이미 묶은 회차 뒤부터 지금까지(하루 이하) 끝난 회차를 한 체크포인트로
    if (this.deps.closed) {
      try {
        const recorded = await this.deps.store.closedEventsSince(nowMs - s.closedDedupMs);
        const seen = new Set(recorded.map((e) => e.eventId));
        const cursor = recorded.reduce((m, e) => Math.max(m, e.closedAtMs + 1), 0);
        const fromMs = Math.max(cursor, nowMs - s.closedLookbackMs);
        if (fromMs < nowMs) {
          const fresh = (await this.deps.closed.closedBetween(fromMs, nowMs)).filter((e) => !seen.has(e.eventId) && e.closedAtMs < nowMs);
          if (fresh.length > 0) {
            const c = await this.#createPublic('EVENT_CLOSE', nowMs, { reason: `EVENT_CLOSE:${fresh.length}`, closedEvents: fresh });
            if (c?.no !== undefined && c.kind === 'EVENT_CLOSE') out.push({ no: c.no, kind: 'EVENT_CLOSE' });
          }
        }
      } catch (e) {
        errors.push(`closed-events:${errName(e)}`);
        this.#log('warn', { event: 'audit-checkpoint-closed-events-unavailable', err: errName(e) }, '끝난 회차 목록을 읽지 못해 이번 실행의 회차 마감 체크포인트를 미룬다');
      }
    }
    // 일: 그날 00:10 KST 뒤 첫 실행(그 뒤 DAILY 행이 없을 때)
    const dueAt = kstDayStartMs(nowMs) + s.dailyAfterKstMs;
    if (nowMs >= dueAt && !(await this.deps.store.dailySince(dueAt))) {
      let anchor: string | undefined;
      if (this.deps.dayAnchors) {
        try {
          anchor = await this.deps.dayAnchors.dayAnchor(kstDate(nowMs));
        } catch (e) {
          errors.push(`day-anchor:${errName(e)}`);
          anchor = undefined;
        }
      }
      const c = await this.#createPublic('DAILY', nowMs, { reason: `DAILY:${kstDate(nowMs)}`, ...(anchor !== undefined ? { accessLogDayAnchor: anchor } : {}) });
      if (c?.no !== undefined && c.kind === 'DAILY') out.push({ no: c.no, kind: 'DAILY' });
    }
    return out;
  }

  /** 체인을 다시 모은 값이 저장된 행과 같은가(서명 전 확인, ADR-0348 결정 10) */
  async #consistent(c: AuditCheckpoint): Promise<boolean> {
    if (!isPublicCheckpoint(c) || c.no === undefined || !c.checkpointJson || !c.checkpointHash) return false;
    const entries = await this.deps.chain.entriesBetween(c.fromSeq, c.toSeq);
    if (entries.length !== c.toSeq - c.fromSeq + 1 || checkpointMerkleRoot(entries) !== c.rootHash) return false;
    if (checkpointHashOf(c.checkpointJson) !== c.checkpointHash) return false;
    const body = parseCheckpointJson(c.checkpointJson);
    if (!body || body.no !== c.no || body.firstSeq !== c.fromSeq || body.lastSeq !== c.toSeq || body.merkleRoot !== c.rootHash || body.leafCount !== entries.length) return false;
    if (body.prevCheckpointHash !== c.prevCheckpointHash) return false;
    if (c.no === 1) return c.prevCheckpointHash === '' && c.fromSeq === 1;
    const prev = await this.deps.store.findByNo(c.no - 1);
    return prev !== undefined && prev.checkpointHash === c.prevCheckpointHash && prev.toSeq === c.fromSeq - 1;
  }

  async #sign(spki: Buffer, mismatches: number[], errors: string[]): Promise<number> {
    let signed = 0;
    for (const c of await this.deps.store.unsignedPublic(AUDIT_ANCHOR_SCHEDULE.batch)) {
      if (!(await this.#consistent(c))) {
        mismatches.push(c.no!);
        this.#log('error', { event: 'audit-checkpoint-mismatch', severity: 'SEV2', no: c.no, checkpointId: c.checkpointId }, '체인을 다시 모은 루트가 저장된 체크포인트와 달라 서명·게시하지 않는다');
        break;
      }
      const message = Buffer.from(c.checkpointJson!, 'utf8');
      let signature: string;
      try {
        signature = (await this.deps.signer.sign(message)).toString('base64');
      } catch (e) {
        errors.push(`sign:${errName(e)}`);
        this.#log('warn', { event: 'audit-checkpoint-sign-failed', no: c.no, err: errName(e) }, '체크포인트를 서명하지 못했다(다음 실행에서 다시)');
        break;
      }
      // 받은 서명이 공개키로 맞는지 본다(키 ID와 키 재료가 어긋나면 게시하지 않는다)
      if (!verifyCheckpointSignature(spki, message, signature)) {
        errors.push('sign:verify-failed');
        this.#log('error', { event: 'audit-checkpoint-sign-mismatch', no: c.no }, '서명이 공개키로 확인되지 않아 저장하지 않는다');
        break;
      }
      if (await this.deps.store.saveSignature(c.checkpointId, signature, this.deps.signer.keyId)) signed += 1;
    }
    return signed;
  }

  async #stamp(nowMs: number, errors: string[]): Promise<number> {
    if (this.deps.calendars.length === 0) return 0;
    let stamped = 0;
    for (const c of await this.deps.store.unstamped(AUDIT_ANCHOR_SCHEDULE.batch)) {
      const r = await stampDigest(Buffer.from(c.checkpointHash!, 'hex'), this.deps.calendars);
      if (!r.proof) {
        errors.push(`ots:all-failed:${c.no}`);
        this.#log('warn', { event: 'audit-ots-all-failed', no: c.no, failed: r.failed.map((f) => f.error) }, '공개 타임스탬프 캘린더가 모두 실패했다(다음 실행에서 다시)');
        continue;
      }
      if (r.failed.length > 0) this.#log('warn', { event: 'audit-ots-partial', no: c.no, accepted: r.accepted.length, failed: r.failed.length }, '일부 캘린더만 대기 증명을 줬다');
      await this.deps.store.saveOts(c.checkpointId, { state: 'PENDING', proof: r.proof, upgradedAtMs: nowMs });
      stamped += 1;
    }
    return stamped;
  }

  /** 파일 하나를 모든 자리에 한 번만 쓴다. 다른 바이트가 있으면 'DIFFERENT' */
  async #putEverywhere(key: string, body: Buffer, contentType: string, nowMs: number): Promise<'OK' | 'DIFFERENT'> {
    for (const t of this.deps.targets) {
      const r = await t.putOnce(key, body, contentType, nowMs);
      if (r === 'DIFFERENT') {
        this.#log('error', { event: 'audit-public-file-conflict', severity: 'SEV2', key, target: t.name }, '같은 이름의 다른 공개 파일이 있어 게시를 멈춘다');
        return 'DIFFERENT';
      }
    }
    return 'OK';
  }

  async #versioned(key: string, body: Buffer, nowMs: number): Promise<void> {
    for (const t of this.deps.targets) {
      const have = await t.get(key);
      if (have && have.equals(body)) continue;
      await t.putVersion(key, body, 'application/json', nowMs);
    }
  }

  async #writeKeys(nowMs: number): Promise<void> {
    const keys = await this.deps.store.signingKeys();
    const body = {
      version: 1,
      keys: keys.map((k) => ({ keyId: k.keyId, alg: k.alg, publicKeyPem: spkiPem(k.publicKeySpki), firstUsedAt: new Date(k.firstUsedAtMs).toISOString() })),
    };
    await this.#versioned(PUBLIC_KEYS_FILE, Buffer.from(JSON.stringify(body), 'utf8'), nowMs);
  }

  async #writeIndex(nowMs: number): Promise<void> {
    const rows = await this.deps.store.publishedIndex();
    const body = {
      version: 1,
      checkpoints: rows.map((r) => {
        const base = checkpointFileBase(r.no);
        return { no: r.no, checkpointHash: r.checkpointHash, json: `${base}.json`, sig: `${base}.sig`, ots: `${base}.ots`, ...(r.complete ? { completeOts: `${base}.complete.ots` } : {}) };
      }),
    };
    await this.#versioned(INDEX_FILE, Buffer.from(JSON.stringify(body), 'utf8'), nowMs);
  }

  async #publish(nowMs: number, conflicts: string[], errors: string[]): Promise<number> {
    const rows = await this.deps.store.unpublished(AUDIT_ANCHOR_SCHEDULE.batch);
    if (rows.length === 0) return 0;
    let published = 0;
    try {
      await this.#writeKeys(nowMs);
      for (const c of rows) {
        // 앞 번호가 게시되지 않았으면 멈춘다(공개 사슬에 빈틈을 만들지 않는다)
        if (c.no! > 1) {
          const prev = await this.deps.store.findByNo(c.no! - 1);
          if (!prev || prev.publishedAtMs === undefined) break;
        }
        const base = checkpointFileBase(c.no!);
        const files: [string, Buffer, string][] = [
          [`${base}.json`, Buffer.from(c.checkpointJson!, 'utf8'), 'application/json'],
          [`${base}.sig`, Buffer.from(c.signature!, 'utf8'), 'text/plain'],
          [`${base}.ots`, c.otsProof!, 'application/vnd.opentimestamps.v1'],
        ];
        let ok = true;
        for (const [key, body, type] of files) {
          if ((await this.#putEverywhere(key, body, type, nowMs)) === 'DIFFERENT') {
            conflicts.push(key);
            ok = false;
            break;
          }
        }
        if (!ok) break;
        if (await this.deps.store.markPublished(c.checkpointId, `${base}.json`, nowMs)) published += 1;
      }
    } catch (e) {
      errors.push(`publish:${errName(e)}`);
      this.#log('warn', { event: 'audit-checkpoint-publish-failed', err: errName(e) }, '공개 파일을 쓰지 못했다(다음 실행에서 다시)');
    }
    if (published > 0) {
      try {
        await this.#writeIndex(nowMs);
      } catch (e) {
        errors.push(`index:${errName(e)}`);
      }
    }
    return published;
  }

  async #upgrade(nowMs: number, conflicts: string[], errors: string[]): Promise<number> {
    if (this.deps.calendars.length === 0) return 0;
    let completed = 0;
    for (const c of await this.deps.store.pendingOts(nowMs - AUDIT_ANCHOR_SCHEDULE.upgradeIntervalMs, AUDIT_ANCHOR_SCHEDULE.batch)) {
      try {
        const r = await upgradeProof(c.otsProof!, this.deps.calendars);
        if (!r.complete) {
          await this.deps.store.saveOts(c.checkpointId, { upgradedAtMs: nowMs });
          continue;
        }
        const key = `${checkpointFileBase(c.no!)}.complete.ots`;
        if ((await this.#putEverywhere(key, r.proof, 'application/vnd.opentimestamps.v1', nowMs)) === 'DIFFERENT') {
          conflicts.push(key);
          break;
        }
        await this.deps.store.saveOts(c.checkpointId, { state: 'COMPLETE', proof: r.proof, upgradedAtMs: nowMs });
        completed += 1;
      } catch (e) {
        errors.push(`ots-upgrade:${errName(e)}`);
      }
    }
    if (completed > 0) {
      try {
        await this.#writeIndex(nowMs);
      } catch (e) {
        errors.push(`index:${errName(e)}`);
      }
    }
    return completed;
  }
}
