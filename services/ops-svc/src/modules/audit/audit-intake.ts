// 다른 서비스의 감사 기록 받기(ADR-0341 결정 7). 내부 경로 POST /internal/v1/ops/audit-records가 {eventKey, recordType, recordId, payload, occurredAt}를 받아
// 행위자 SYSTEM의 감사 기록으로 덧붙인다. 같은 eventKey는 한 번만이다(audit_record_intake 기본 키, 덧붙임과 같은 트랜잭션).
// 받는 recordType은 허용 목록이고 종류마다 payload 칸도 허용 목록이다(목록 밖 칸·개인정보 칸은 400). 첫 값은 SHUFFLE_COMMIT_DISCLOSED(ADR-0232 결정 10)다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAuditIn, type AuditChain } from './audit.js';

/** 시스템 행위자의 가명 참조(모든 자리가 0인 UUID, ADR-0340 결정 8) */
const SYSTEM_ACTOR_REF = '00000000-0000-0000-0000-000000000000';

/** 받는 기록 종류와 payload 칸(다른 묶음이 값을 더한다). 사람을 가리키는 칸은 받지 않는다 */
export const AUDIT_INTAKE_PAYLOADS = {
  // 셔플 커밋 공시(queue-svc, POL-005·ADR-0232 결정 10): 회차, 구간(로비·묶음 번호), 커밋(SHA-256 16진), drand 체인·라운드, 알고리즘 판
  SHUFFLE_COMMIT_DISCLOSED: z
    .object({
      eventId: z.uuid(),
      group: z.union([z.literal('lobby'), z.number().int().positive()]),
      commit: z.string().regex(/^[0-9a-f]{64}$/),
      chain: z.string().min(1).max(64),
      round: z.number().int().nonnegative(),
      algorithm: z.string().min(1).max(32),
    })
    .strict(),
} as const;
export type AuditIntakeRecordType = keyof typeof AUDIT_INTAKE_PAYLOADS;
export const AUDIT_INTAKE_RECORD_TYPES = Object.keys(AUDIT_INTAKE_PAYLOADS) as AuditIntakeRecordType[];

export const AuditRecordIntakeBody = z
  .object({
    eventKey: z.string().min(1).max(200),
    recordType: z.enum(AUDIT_INTAKE_RECORD_TYPES as [AuditIntakeRecordType, ...AuditIntakeRecordType[]]),
    recordId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type AuditRecordIntakeBody = z.output<typeof AuditRecordIntakeBody>;
export const AuditRecordIntakeResponse = z.object({ accepted: z.boolean(), seq: z.number().int() });

/** 받은 기록의 감사 payload: 보낸 값 + 행위자 SYSTEM·보낸 서비스의 사건 키·일어난 시각 */
export function intakeRecordOf(body: AuditRecordIntakeBody, nowMs: number): { recordType: string; recordId: string; payload: Record<string, unknown>; nowMs: number } {
  const payload = AUDIT_INTAKE_PAYLOADS[body.recordType].parse(body.payload);
  return { recordType: body.recordType, recordId: body.recordId, payload: { ...payload, eventKey: body.eventKey, occurredAt: body.occurredAt, actorRef: SYSTEM_ACTOR_REF, actorRole: 'system' }, nowMs };
}

/** 받은 기록을 한 번만 덧붙이는 저장소 */
export interface AuditIntakeStore {
  /** 처음이면 덧붙이고 그 seq, 이미 받은 eventKey면 처음 seq */
  accept(eventKey: string, record: ReturnType<typeof intakeRecordOf>): Promise<{ readonly seq: number; readonly duplicate: boolean }>;
}

@Injectable()
export class DrizzleAuditIntakeStore implements AuditIntakeStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async accept(eventKey: string, record: ReturnType<typeof intakeRecordOf>): Promise<{ seq: number; duplicate: boolean }> {
    return this.database.transaction(async (tx) => {
      // 사건 키 행이 첫 쓰기다: 같은 키가 겹쳐 오면 뒤의 것은 앞의 커밋을 기다렸다가 처음 seq를 읽는다
      const claimed = await tx.execute(sql`
        insert into audit_record_intake (event_key, seq, received_at) values (${eventKey}, 0, ${new Date(record.nowMs)}::timestamptz)
        on conflict (event_key) do nothing returning 1 as claimed`);
      if (claimed.rows.length === 0) {
        const [row] = (await tx.execute(sql`select seq from audit_record_intake where event_key = ${eventKey}`)).rows as { seq: number | string }[];
        return { seq: Number(row?.seq ?? 0), duplicate: true };
      }
      const seq = await appendAuditIn(tx, record);
      await tx.execute(sql`update audit_record_intake set seq = ${seq}::bigint where event_key = ${eventKey}`);
      return { seq, duplicate: false };
    });
  }
}

export class MemoryAuditIntakeStore implements AuditIntakeStore {
  readonly #seen = new Map<string, number>();

  constructor(private readonly chain: AuditChain & { headSeq(): Promise<number> }) {}

  async accept(eventKey: string, record: ReturnType<typeof intakeRecordOf>): Promise<{ seq: number; duplicate: boolean }> {
    const seen = this.#seen.get(eventKey);
    if (seen !== undefined) return { seq: seen, duplicate: true };
    await this.chain.append(record);
    const seq = await this.chain.headSeq();
    this.#seen.set(eventKey, seq);
    return { seq, duplicate: false };
  }
}
