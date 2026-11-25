// 정산 계좌 변경 감사 기록 받기(J-T40 ⑦, F-07-7 LCH-120, ADR-0370 결정 5, ADR-0341 결정 7, settlement §8 '정산 계좌 변경' 행).
// payment-svc 정산 일꾼이 payout_account_change 행을 POST /internal/v1/ops/audit-records(recordType PAYOUT_ACCOUNT_CHANGED)로 보낸다.
// ops는 허용 칸(파트너·행위자·결과·재인증 요소·예금주 일치·은행·끝 4자리·보류 끝·결제사별 결과)만 받고,
// 목록 밖 칸(계좌번호·예금주명)과 칸마다 허용 값 밖은 400이며 아무것도 쓰지 않는다. 같은 사건 키는 체인 행 하나다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-27T01:00:00.000Z');
const SYSTEM_REF = '00000000-0000-0000-0000-000000000000';
const opened: Array<Awaited<ReturnType<typeof createService>>> = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
  vi.unstubAllEnvs();
});

async function harness() {
  const token = `it-${randomUUID()}`;
  vi.stubEnv('PEAKET_INTERNAL_TOKEN', token);
  const audit = new MemoryAuditChain();
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: audit }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  opened.push(svc);
  const post = (body: unknown, headers: Record<string, string> = { 'x-peaket-internal-token': token }) =>
    svc.http.inject({ method: 'POST', url: '/internal/v1/ops/audit-records', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  return { audit, post };
}

/** payment-svc가 보내는 본문(계획 I-04: eventKey = payout-account-change:{행 ID}, recordId = 행 ID) */
function changed(payload: Record<string, unknown> = {}) {
  const rowId = randomUUID();
  return {
    eventKey: `payout-account-change:${rowId}`,
    recordType: 'PAYOUT_ACCOUNT_CHANGED',
    recordId: rowId,
    payload: {
      promoterId: randomUUID(),
      actorAccountId: randomUUID(),
      result: 'ACCEPTED',
      reauthFactors: ['password', 'totp', 'passkey'],
      holderMatched: true,
      bankCode: '88',
      accountLast4: '4321',
      holdUntil: '2026-12-02T01:00:00.000Z',
      agencies: { PORTONE: 'UPDATED', TOSS_STANDARD: 'UPDATED', TOSS_ESCROW: 'REGISTERED' },
      ...payload,
    },
    occurredAt: new Date(NOW - 60_000).toISOString(),
  };
}

describe('J-T40 ⑦ PAYOUT_ACCOUNT_CHANGED 감사 받기', () => {
  test('J-T40 ⑦ 결과 셋(ACCEPTED·HOLDER_MISMATCH·AGENCY_FAILED)을 받아 행위자 SYSTEM의 체인 행으로 남기고, 같은 사건 키는 한 행이다 [ASVS v5.0.0-16.3.1]', async () => {
    const h = await harness();
    const accepted = changed();
    const mismatch = changed({ result: 'HOLDER_MISMATCH', holderMatched: false, holdUntil: null, agencies: { PORTONE: 'SKIPPED', TOSS_STANDARD: 'SKIPPED', TOSS_ESCROW: 'SKIPPED' } });
    const failed = changed({ result: 'AGENCY_FAILED', agencies: { PORTONE: 'UPDATED', TOSS_STANDARD: 'FAILED', TOSS_ESCROW: 'UPDATED' } });
    const seqs: number[] = [];
    for (const b of [accepted, mismatch, failed]) {
      const r = await h.post(b);
      expect(r.statusCode, String(b.payload.result)).toBe(202);
      seqs.push((JSON.parse(r.payload) as { seq: number }).seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
    const again = await h.post(accepted);
    expect([again.statusCode, JSON.parse(again.payload)]).toEqual([202, { accepted: true, duplicate: true, seq: 1 }]);
    expect(h.audit.entries).toHaveLength(3);
    expect(h.audit.entries[0]).toMatchObject({ seq: 1, recordType: 'PAYOUT_ACCOUNT_CHANGED', recordId: accepted.recordId });
    expect(h.audit.entries[0]!.record.payload).toEqual({ ...accepted.payload, eventKey: accepted.eventKey, occurredAt: accepted.occurredAt, actorRef: SYSTEM_REF, actorRole: 'system' });
    expect(h.audit.entries[1]!.record.payload).toMatchObject({ result: 'HOLDER_MISMATCH', holderMatched: false, holdUntil: null });
  });

  test('J-T40 ⑦ 목록 밖 칸(계좌번호·예금주명 등)과 칸마다 허용 값 밖은 400이고 아무것도 쓰지 않는다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-15.3.3]', async () => {
    const h = await harness();
    const cases: [string, unknown][] = [
      ['계좌번호 칸', changed({ accountNumber: '110987654321' })],
      ['예금주명 칸', changed({ holderName: '(주)스텔라엔터테인먼트' })],
      ['재인증 토큰 칸', changed({ reauthToken: 'eyJhbGciOi' })],
      ['끝 4자리 3자리', changed({ accountLast4: '321' })],
      ['끝 4자리 5자리', changed({ accountLast4: '54321' })],
      ['끝 4자리 글자', changed({ accountLast4: '43a1' })],
      ['결과 목록 밖', changed({ result: 'REJECTED' })],
      ['결과 소문자', changed({ result: 'accepted' })],
      ['재인증 요소 목록 밖', changed({ reauthFactors: ['password', 'sms'] })],
      ['결제사 값 목록 밖', changed({ agencies: { PORTONE: 'DONE', TOSS_STANDARD: 'UPDATED', TOSS_ESCROW: 'UPDATED' } })],
      ['결제사 이름 목록 밖', changed({ agencies: { PORTONE: 'UPDATED', TOSS_STANDARD: 'UPDATED', TOSS_ESCROW: 'UPDATED', KCP: 'UPDATED' } })],
      ['파트너 ID가 UUID 아님', changed({ promoterId: 'stella' })],
      ['행위자 ID가 UUID 아님', changed({ actorAccountId: 'admin' })],
      ['예금주 일치가 글', changed({ holderMatched: 'true' })],
      ['보류 끝이 날짜 아님', changed({ holdUntil: '다음 주 수요일' })],
      ['은행 코드 빔', changed({ bankCode: '' })],
    ];
    for (const [label, body] of cases) {
      const r = await h.post(body);
      expect(r.statusCode, label).toBe(400);
    }
    // 내부 토큰 없이는 받지 않는다
    expect((await h.post(changed(), {})).statusCode).toBe(403);
    expect(h.audit.entries).toEqual([]);
    // 대조: 같은 모양의 바른 본문은 받는다(거부가 recordType 하나 때문이 아니라 칸 규칙 때문인지 본다)
    const ok = await h.post(changed());
    expect([ok.statusCode, JSON.parse(ok.payload)]).toEqual([202, { accepted: true, duplicate: false, seq: 1 }]);
    expect(h.audit.entries).toHaveLength(1);
  });
});
