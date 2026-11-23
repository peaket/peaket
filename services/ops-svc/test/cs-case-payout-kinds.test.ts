// J-T38 ⑥ ops-svc가 지급 쪽 CS 건 다섯 종류를 받는다(F-07-6 LCH-110, ADR-0369 결정 10, docs/features/settlement.md §5.2·§6·§12).
// payment-svc HttpSettlementCaseNotice.openCase가 POST /internal/v1/cs-cases로 보내는 모양(eventKey·kind·sourceId·category SETTLEMENT·createdAt)을 그대로 쓴다.
// 다섯(SELLER_KYC_REQUIRED·PAYOUT_ERROR·PAYOUT_FAILED·PAYOUT_DELAYED·PG_BALANCE_MISMATCH)은 건을 열고, 같은 사건 키는 한 건이며,
// 목록 밖 종류(정산 운영 종류라도 PORTONE_PAYOUT_EXECUTION·PORTONE_LEDGER_MISMATCH 등)는 여전히 받지 않는다(accepted false).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-12-04T06:00:00.000Z');
const PAYOUT_KINDS = ['SELLER_KYC_REQUIRED', 'PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'PG_BALANCE_MISMATCH'] as const;

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

const body = (kind: string, sourceId: string, eventKey: string) => ({ eventKey, kind, sourceId, category: 'SETTLEMENT', createdAt: new Date(NOW).toISOString() });
const post = (b: unknown) => svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(b) });

describe('J-T38 ⑥ 지급 쪽 CS 건 종류', () => {
  test('J-T38 ⑥ 다섯 종류는 202·accepted true로 건을 열고, 같은 사건 키를 다시 보내도 같은 건이다', async () => {
    for (const kind of PAYOUT_KINDS) {
      const sourceId = kind === 'PG_BALANCE_MISMATCH' ? `TOSS:STANDARD:${randomUUID()}` : randomUUID();
      const eventKey = `${kind.toLowerCase()}:${randomUUID()}`;
      const first = await post(body(kind, sourceId, eventKey));
      expect([kind, first.statusCode, JSON.parse(first.payload)]).toEqual([kind, 202, { accepted: true, caseId: expect.any(String) }]);
      const again = await post(body(kind, sourceId, eventKey));
      expect([kind, JSON.parse(again.payload)]).toEqual([kind, { accepted: true, caseId: (JSON.parse(first.payload) as { caseId: string }).caseId }]);
    }
  });

  test('J-T38 ⑥ 건은 그 종류·대상(묶음·지급 건·토스 셀러·TOSS:{상점})으로 열린다', async () => {
    const store = new MemoryCsCaseStore();
    const receive = new ReceiveCaseRequested(store);
    const opened: { kind: string; targetRef: string }[] = [];
    const requests = [
      ['SELLER_KYC_REQUIRED', 'FSEL000001'],
      ['PAYOUT_ERROR', randomUUID()],
      ['PAYOUT_FAILED', randomUUID()],
      ['PAYOUT_DELAYED', `TOSS:ESCROW:2026-12-07`],
      ['PG_BALANCE_MISMATCH', 'TOSS:STANDARD'],
    ] as const;
    for (const [kind, sourceId] of requests) {
      const r = await receive.handle({ ...body(kind, sourceId, randomUUID()), kind }, NOW);
      expect([kind, r.accepted, r.result]).toEqual([kind, true, 'opened']);
      opened.push({ kind: r.case!.kind, targetRef: r.case!.targetRef });
    }
    expect(opened).toEqual(requests.map(([kind, sourceId]) => ({ kind, targetRef: sourceId })));
    expect(store.cases.size).toBe(5);
  });

  test('J-T38 ⑥ 목록 밖 종류(PORTONE_PAYOUT_EXECUTION·PORTONE_LEDGER_MISMATCH·UNKNOWN_PAYMENT·모르는 이름)는 여전히 받지 않는다', async () => {
    for (const kind of ['PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH', 'UNKNOWN_PAYMENT', 'PAYOUT_CANCELED']) {
      const r = await post(body(kind, randomUUID(), randomUUID()));
      expect([kind, r.statusCode, JSON.parse(r.payload)]).toEqual([kind, 202, { accepted: false }]);
    }
  });
});
