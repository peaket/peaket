// ops 받기의 거절과 다시 보내기 상한(F-07-7 계획 §5.1 (파) (마)·(바), 감독 결정 2026-11-23, settlement §8·§11, guidelines §8.1).
// payment가 ops에 보내는 셋 — CS 건(F-07-6·F-07-7 openCase, F-07-5 정산 이의 openDispute), 운영 경보, 감사 기록 — 은
// 202 accepted:false·400·422를 '거절'로 보고 보낸 것으로 세지 않는다. 거절 3번째에 영구 실패(failed_at·last_refusal)로 남기고 더 보내지 않으며
// 로그 ops_intake_refused와 지표 settlement_ops_intake_refused_total{target}·settlement_ops_intake_failed{target}로 보인다.
// 연결 실패·5xx 같은 일시 실패는 세지 않고 30분마다 다시 보낸다. ops는 대역 서버(test/support/ops-intake-fake.ts)이고 받은 요청 수로 센다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { OpsIntakeFake, type OpsFakeMode } from './support/ops-intake-fake.js';
import { harness, leaks, type Harness } from './support/settlement-portone-harness.js';

const NOW = Date.parse('2026-12-02T03:00:00.000Z');
const ACCOUNT = '11012345678901';

const ops = new OpsIntakeFake();
beforeAll(async () => {
  await ops.start();
});
afterAll(async () => {
  await ops.close();
});

let h: Harness;
beforeEach(() => {
  ops.reset();
  h = harness({ now: NOW, ops });
});

interface Target {
  name: string;
  path: string;
  /** 보낼 행 하나를 심고 그 사건 키를 돌려준다 */
  seed(): string;
  /** 정산 일꾼 30분 tick 몫의 다시 보내기 */
  retry(): Promise<unknown>;
  /** 그 행의 보낸 시각·거절 수·영구 실패 시각·마지막 거절 */
  row(key: string): { sentAt: Date | null; refusedCount: number; failedAt: Date | null; lastRefusal?: string | null };
}

const targets: Target[] = [
  {
    name: 'CS 건(settlement_case_request, openCase)',
    path: '/internal/v1/cs-cases',
    seed: () => {
      const batchId = randomUUID();
      const eventKey = `portone-execution:${batchId}`;
      h.store.caseRequests.set(eventKey, { eventKey, kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: batchId, createdAt: new Date(NOW), requestedAt: null, detail: '뺀 정산서 1건: s-1(ACCOUNT_CHANGE)', refusedCount: 0, failedAt: null, lastRefusal: null });
      return eventKey;
    },
    retry: () => h.settlements.retryPayoutCases(),
    row: (key) => {
      const r = h.store.caseRequests.get(key)!;
      return { sentAt: r.requestedAt, refusedCount: r.refusedCount, failedAt: r.failedAt, lastRefusal: r.lastRefusal };
    },
  },
  {
    name: '운영 경보(settlement_alert_request)',
    path: '/internal/v1/ops-alerts',
    seed: () => {
      const eventKey = `portone-transfer-alert:${randomUUID()}`;
      h.store.alertRequests.set(eventKey, { eventKey, kind: 'settlement_portone_withdrawal_unmatched', severity: 'SEV2', sourceId: 'at-x', createdAt: new Date(NOW), requestedAt: null, refusedCount: 0, failedAt: null, lastRefusal: null });
      return eventKey;
    },
    retry: () => h.settlements.retrySettlementAlerts(),
    row: (key) => {
      const r = h.store.alertRequests.get(key)!;
      return { sentAt: r.requestedAt, refusedCount: r.refusedCount, failedAt: r.failedAt, lastRefusal: r.lastRefusal };
    },
  },
  {
    name: '감사 기록(payout_account_change)',
    path: '/internal/v1/ops/audit-records',
    seed: () => {
      const id = randomUUID();
      h.store.payoutAccountChanges.push({
        id,
        promoterId: randomUUID(),
        actorAccountId: randomUUID(),
        reauthJti: `jti-${id}`,
        result: 'ACCEPTED',
        bankCode: '88',
        accountLast4: '8901',
        holdUntil: new Date(NOW + 5 * 86_400_000),
        agencyResults: { PORTONE: 'UPDATED', TOSS_STANDARD: 'UPDATED', TOSS_ESCROW: 'UPDATED' },
        createdAt: new Date(NOW),
        auditSentAt: null,
        auditRefusedCount: 0,
        auditFailedAt: null,
      });
      return id;
    },
    retry: () => h.settlements.retryPayoutAccountAudits(),
    row: (key) => {
      const r = h.store.payoutAccountChanges.find((c) => c.id === key)!;
      return { sentAt: r.auditSentAt, refusedCount: r.auditRefusedCount, failedAt: r.auditFailedAt };
    },
  },
  {
    name: '정산 이의 CS 건(F-07-5 statement_dispute, retryDisputeCases)',
    path: '/internal/v1/cs-cases',
    seed: () => {
      const disputeId = randomUUID();
      h.store.disputes.set(disputeId, {
        disputeId,
        statementId: randomUUID(),
        reasonCode: 'GROSS_AMOUNT',
        detail: '',
        submittedBy: randomUUID(),
        submittedAt: new Date(NOW),
        result: null,
        resolvedAt: null,
        caseRequestedAt: null,
        caseRefusedCount: 0,
        caseFailedAt: null,
      });
      return disputeId;
    },
    retry: () => h.settlements.retryDisputeCases(),
    row: (key) => {
      const r = h.store.disputes.get(key)!;
      return { sentAt: r.caseRequestedAt ?? null, refusedCount: r.caseRefusedCount ?? 0, failedAt: r.caseFailedAt ?? null };
    },
  },
];

const metricLines = async (name: string): Promise<{ target: string; value: number }[]> =>
  (await h.registry.metrics())
    .split('\n')
    .map((l) => new RegExp(`^${name}\\{target="([^"]+)"\\} (\\S+)$`).exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ target: m[1]!, value: Number(m[2]) }));

describe.each(targets)('ops 받기 거절: $name', (t) => {
  test('J-T40 ⑦·J-T41 ② (1) 202 accepted:false는 성공으로 세지 않는다 — 보낸 시각이 비고 거절 수가 1 오르며 다음 tick에 다시 보낸다', async () => {
    const key = t.seed();
    ops.mode = 'refuse';
    await t.retry();
    expect(ops.refused.get(t.path)).toBe(1);
    expect(t.row(key)).toMatchObject({ sentAt: null, refusedCount: 1, failedAt: null });
    await t.retry();
    expect(ops.refused.get(t.path)).toBe(2);
    expect(t.row(key)).toMatchObject({ sentAt: null, refusedCount: 2, failedAt: null });
    // 받히면 그때 보낸 것이다
    ops.mode = 'up';
    h.clock.advance(30 * 60_000);
    await t.retry();
    expect(t.row(key)).toMatchObject({ sentAt: new Date(h.clock.now()), failedAt: null });
  });

  test.each([
    ['202 accepted:false', 'refuse' as OpsFakeMode, 'NOT_ACCEPTED'],
    ['400', '400' as OpsFakeMode, 'HTTP_400'],
    ['422', '422' as OpsFakeMode, 'HTTP_422'],
  ])('J-T40 ⑦·J-T41 ② (2) %s 거절 3번째에 영구 실패로 남고 그 뒤 tick은 보내지 않으며 로그 ops_intake_refused와 지표 두 값이 맞다', async (_label, mode, refusal) => {
    const key = t.seed();
    ops.mode = mode;
    for (let i = 1; i <= 2; i += 1) {
      await t.retry();
      expect(t.row(key)).toMatchObject({ refusedCount: i, failedAt: null });
    }
    expect(h.log.lines.filter((l) => l.includes('"ops_intake_refused"'))).toEqual([]);
    h.clock.advance(30 * 60_000);
    await t.retry();
    const row = t.row(key);
    expect(row).toMatchObject({ sentAt: null, refusedCount: 3, failedAt: new Date(h.clock.now()) });
    if ('lastRefusal' in row) expect(row.lastRefusal).toBe(refusal);
    expect(ops.refused.get(t.path)).toBe(3);
    // 그 뒤 tick은 보내지 않는다(ops가 살아나도)
    ops.mode = 'up';
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(30 * 60_000);
      await t.retry();
    }
    expect(ops.refused.get(t.path)).toBe(3);
    expect(ops.audits.length + ops.alerts.length + ops.cases.length).toBe(0);
    expect(t.row(key)).toMatchObject({ sentAt: null, refusedCount: 3 });
    // 로그 한 줄: 사건 키·거절 까닭(개인정보·계좌번호 없음)
    const logged = h.log.lines.filter((l) => l.includes('"ops_intake_refused"'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(key);
    expect(logged[0]).toContain(refusal);
    expect(leaks(h.log.text(), ACCOUNT)).toEqual([]);
    // 지표: 거절마다 카운터, 영구 실패 행 수 게이지(같은 대상 이름표)
    const refused = (await metricLines('settlement_ops_intake_refused_total')).filter((m) => m.value > 0);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.value).toBe(3);
    expect((await metricLines('settlement_ops_intake_failed')).filter((m) => m.target === refused[0]!.target)).toEqual([{ target: refused[0]!.target, value: 1 }]);
  });

  test('J-T40 ⑦·J-T41 ② (3) 일시 실패(503)는 다섯 번 뒤에도 영구 실패가 아니고 거절로 세지 않으며, 살아나면 보낸다', async () => {
    const key = t.seed();
    ops.mode = '503';
    for (let i = 0; i < 5; i += 1) {
      await t.retry();
      h.clock.advance(30 * 60_000);
    }
    expect(ops.refused.get(t.path)).toBe(5);
    expect(t.row(key)).toMatchObject({ sentAt: null, refusedCount: 0, failedAt: null });
    expect(h.log.lines.filter((l) => l.includes('"ops_intake_refused"'))).toEqual([]);
    expect((await metricLines('settlement_ops_intake_refused_total')).filter((m) => m.value > 0)).toEqual([]);
    ops.mode = 'up';
    await t.retry();
    expect(t.row(key)).toMatchObject({ sentAt: new Date(h.clock.now()), failedAt: null });
  });
});
