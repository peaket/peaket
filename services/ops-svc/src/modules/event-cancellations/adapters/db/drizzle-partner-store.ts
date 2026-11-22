// 파트너 경로 전용 회차 취소 요청 저장소(BAT-420 웨이브 끝 리뷰 S2, docs/security/authz-matrix.md §5.3 'ops-svc 구현', ops 0015).
// 파트너 DB 풀(ops_partner 역할, PEAKET_PARTNER_DATABASE_URL)로만 접속하고, 트랜잭션 첫 문장에서 set_config('app.tenant_id', 세션 테넌트, true)를 건다
// (platform Database.transaction의 tenantId). 행 보안이 다른 파트너의 행을 막는다. 감사 체인 덧붙이기와 CS '판정 대기' 건은 정의자 권한 함수
// ops_append_audit·ops_open_cs_case로 같은 트랜잭션에서 남긴다(ops_partner는 audit_chain·cs_case를 직접 읽거나 쓰지 못한다).
// 멱등 기록(idempotency_record)은 읽기·넣기만 받으므로 처음 응답을 넣기 문장에 함께 싣는다(platform IdempotencyStore의 고치기 문장을 쓰지 않는다).
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { IDEMPOTENCY_RECORD_TABLE, IDEMPOTENCY_WAIT_MS, idempotencyKeyReused, idempotencyRequestInProgress, systemClock, type Clock, type Database, type DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { canonicalAuditRecord, type AuditRecord } from '../../../audit/audit.js';
import { eventCancellationView, type EventCancellationRecord, type EventCancellationView } from '../../domain/event-cancellation.js';
import type { EventCancellationIdempotency, EventCancellationInsert, PartnerEventCancellationStore } from '../../domain/ports.js';
import { ACTIVE_CONDITION, ActiveRequest, COLUMNS, constraintOf, insertValues, pgCode, recordOf, type Row } from './drizzle-store.js';

/** 멱등 키 행을 기다리다 끝난 오류(lock_timeout·statement 취소) */
const WAIT_ENDED: ReadonlySet<string> = new Set(['55P03', '57014']);

export class DrizzlePartnerEventCancellationStore implements PartnerEventCancellationStore {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * 한 트랜잭션(tenantId를 첫 문장으로 건다): (멱등 키 행 넣기 →) 같은 회차의 진행 중 요청 확인(그 테넌트에 보이는 행) → 행 넣기(행 보안이 테넌트를 다시 본다) →
   * 감사(ops_append_audit) → (cs가 있으면) CS '판정 대기' 건(ops_open_cs_case). 진행 중이면 트랜잭션째 되돌려 키 행도 남기지 않는다.
   * 같은 키·같은 지문이면 REPLAYED, 다른 지문이면 422 idempotency-key-reused를 던진다. 보관 기간이 지난 키도 다시 쓰지 않는다(고치기 권한이 없다)
   */
  async insertAsTenant(
    tenantId: string,
    record: EventCancellationRecord,
    audit: AuditRecord,
    idem?: EventCancellationIdempotency,
    cs?: { readonly nowMs: number; readonly resultDueMs?: number },
  ): Promise<EventCancellationInsert> {
    try {
      return await this.database.transaction(
        async (tx): Promise<EventCancellationInsert> => {
          if (idem) {
            const first = eventCancellationView(record);
            const claimed = await this.#claimKey(tx, idem, JSON.stringify(first));
            if (!claimed) return { status: 'REPLAYED', view: await this.#replayIn(tx, idem) };
          }
          await this.#insertIn(tx, record, audit, cs);
          return { status: 'INSERTED' };
        },
        { tenantId },
      );
    } catch (err) {
      if (err instanceof ActiveRequest) return { status: 'ACTIVE', requestId: err.requestId };
      // 확인과 넣기 사이에 다른 요청이 먼저 커밋했다(부분 유일 인덱스가 막음). 그 테넌트에 보이면 그 요청을, 안 보이는 옛 행이면 ID 없이 알린다
      if (pgCode(err) === '23505' && constraintOf(err) === 'event_cancellation_request_active_key') {
        const active = await this.activeForEventAsTenant(tenantId, record.eventId);
        return { status: 'ACTIVE', requestId: active?.requestId ?? '' };
      }
      throw err;
    }
  }

  /** 그 테넌트에 보이는 그 회차의 가장 최근 요청(파트너 상태) */
  async latestForEventAsTenant(tenantId: string, eventId: string): Promise<EventCancellationRecord | undefined> {
    return this.database.transaction(
      async (tx) => {
        const r = await tx.execute(sql`select ${COLUMNS} from event_cancellation_request where event_id = ${eventId}::uuid order by requested_at desc, request_id desc limit 1`);
        const row = r.rows[0] as unknown as Row | undefined;
        return row ? recordOf(row) : undefined;
      },
      { tenantId, accessMode: 'read only' },
    );
  }

  /** 그 테넌트에 보이는 그 회차의 진행 중 요청. 테넌트가 다른 요청이나 promoter_id가 빈 옛 commander 요청은 보이지 않는다 */
  async activeForEventAsTenant(tenantId: string, eventId: string): Promise<EventCancellationRecord | undefined> {
    return this.database.transaction(
      async (tx) => {
        const r = await tx.execute(sql`select ${COLUMNS} from event_cancellation_request where event_id = ${eventId}::uuid and ${ACTIVE_CONDITION} order by requested_at desc limit 1`);
        const row = r.rows[0] as unknown as Row | undefined;
        return row ? recordOf(row) : undefined;
      },
      { tenantId, accessMode: 'read only' },
    );
  }

  /** 같은 멱등 키의 커밋된 처음 응답(없으면 undefined, 다른 지문이면 422). 보관 기간과 관계없이 본다(넣기와 같은 규칙) */
  async replayOfAsTenant(tenantId: string, idem: EventCancellationIdempotency): Promise<EventCancellationView | undefined> {
    return this.database.transaction(
      async (tx) => {
        const row = await this.#keyRow(tx, idem);
        if (!row || row.result_ref === null) return undefined;
        this.#sameHash(row.request_hash, idem);
        return JSON.parse(row.result_ref) as EventCancellationView;
      },
      { tenantId, accessMode: 'read only' },
    );
  }

  /** 키 행을 처음 응답과 함께 넣는다. 아직 커밋하지 않은 같은 키가 있으면 기다린다(1초 [가정], 넘으면 409 처리 중). 넣었으면 true */
  async #claimKey(tx: DbTransaction, idem: EventCancellationIdempotency, resultRef: string): Promise<boolean> {
    const t = sql.identifier(IDEMPOTENCY_RECORD_TABLE);
    try {
      await tx.execute(sql`select set_config('lock_timeout', ${`${IDEMPOTENCY_WAIT_MS}ms`}, true)`);
      const r = await tx.execute(sql`
        insert into ${t} (account_ref, operation, idempotency_key, request_hash, result_ref, created_at)
        values (${idem.accountRef}, ${idem.operation}, ${idem.key}, ${Buffer.from(idem.requestHash)}, ${resultRef}, ${new Date(this.clock.now())})
        on conflict (account_ref, operation, idempotency_key) do nothing
        returning 1 as claimed`);
      await tx.execute(sql`set local lock_timeout to default`);
      return r.rows.length === 1;
    } catch (e) {
      const code = pgCode(e);
      if (code !== undefined && WAIT_ENDED.has(code)) throw idempotencyRequestInProgress(e);
      throw e;
    }
  }

  async #replayIn(tx: DbTransaction, idem: EventCancellationIdempotency): Promise<EventCancellationView> {
    const row = await this.#keyRow(tx, idem);
    // 그사이 정비 잡이 지웠거나 결과가 비었다: 처리 중과 같게 다시 보내게 한다
    if (!row || row.result_ref === null) throw idempotencyRequestInProgress();
    this.#sameHash(row.request_hash, idem);
    return JSON.parse(row.result_ref) as EventCancellationView;
  }

  async #keyRow(tx: DbTransaction, idem: EventCancellationIdempotency): Promise<{ request_hash: Buffer; result_ref: string | null } | undefined> {
    const r = await tx.execute(sql`
      select request_hash, result_ref from ${sql.identifier(IDEMPOTENCY_RECORD_TABLE)}
       where account_ref = ${idem.accountRef} and operation = ${idem.operation} and idempotency_key = ${idem.key}`);
    return r.rows[0] as { request_hash: Buffer; result_ref: string | null } | undefined;
  }

  #sameHash(stored: Buffer, idem: EventCancellationIdempotency): void {
    const a = Buffer.from(stored);
    const b = Buffer.from(idem.requestHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw idempotencyKeyReused();
  }

  async #insertIn(tx: DbTransaction, r: EventCancellationRecord, audit: AuditRecord, cs?: { readonly nowMs: number; readonly resultDueMs?: number }): Promise<void> {
    const active = await tx.execute(sql`select request_id from event_cancellation_request where event_id = ${r.eventId}::uuid and ${ACTIVE_CONDITION} limit 1`);
    const existing = (active.rows[0] as { request_id: string } | undefined)?.request_id;
    if (existing !== undefined) throw new ActiveRequest(existing);
    await tx.execute(sql`insert into event_cancellation_request (${COLUMNS}) values ${insertValues(r)}`);
    await tx.execute(sql`
      select ops_append_audit(${audit.recordType}, ${audit.recordId}::uuid, ${canonicalAuditRecord(audit)}, ${randomBytes(32)}, ${new Date(audit.nowMs)}::timestamptz)`);
    // 넷째 인자는 판정 기한(ops 0030). 없으면 NULL(기한 없음)이다
    if (cs) {
      const due = cs.resultDueMs !== undefined ? sql`${new Date(cs.resultDueMs)}::timestamptz` : sql`null::timestamptz`;
      await tx.execute(sql`select ops_open_cs_case(${randomUUID()}::uuid, ${r.requestId}::uuid, ${new Date(cs.nowMs)}::timestamptz, ${due})`);
    }
  }
}
