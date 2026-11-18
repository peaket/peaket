// P-T75 ① CS 처리함 받는 층의 계약(BAT-420-rest 리뷰 반영 RV-01, 시험 담당 l3-b420-test, 2026-11-19).
// purchase-svc CS 건 어댑터 다섯 종류가 보내는 본문(services/purchase-svc/test/fixtures/cs-case-bodies.json, 두 서비스가 같은 파일을 읽는다)을
// 실제 CasesController·ReceiveCaseRequested·메모리 저장소에 넣는다. 정본: docs/features/transfer-refund.md §3.1 ⑥ '실패 기록'(ops-svc는 환불 대기를 받는 종류에 더해 건을 만든다),
// docs/features/payment.md §11 P-T75 ①(종류 다섯마다 accepted: true, 건 한 번, 같은 eventKey로 다시 보내도 한 건).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CasesController, MemoryCsCaseStore, ReceiveCaseRequested } from '../src/modules/cases/index.js';

interface Case {
  name: string;
  body: Record<string, unknown> & { kind: string; sourceId: string };
}
const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('../../purchase-svc/test/fixtures/cs-case-bodies.json', import.meta.url)), 'utf8')) as { nowMs: number; cases: Case[] };

describe('P-T75 ① purchase-svc CS 건 본문 다섯 종류를 실제 받는 층에 넣는다', () => {
  test('P-T75 ① 다섯 종류마다 accepted: true·caseId이고 건이 한 번 생기며, 같은 본문을 다시 보내도 같은 건 하나다', async () => {
    expect(FIXTURE.cases).toHaveLength(5);
    for (const c of FIXTURE.cases) {
      const store = new MemoryCsCaseStore();
      const controller = new CasesController(new ReceiveCaseRequested(store), fakeClock({ now: FIXTURE.nowMs }));
      const first = await controller.create(c.body);
      expect(first, c.name).toMatchObject({ accepted: true, caseId: expect.any(String) });
      expect(store.cases.size, c.name).toBe(1);
      expect([...store.cases.values()][0], c.name).toMatchObject({ kind: c.body.kind, targetRef: c.body.sourceId, status: 'OPEN' });
      const again = await controller.create(c.body);
      expect(again, `${c.name} 다시`).toEqual(first);
      expect(store.cases.size, `${c.name} 다시`).toBe(1);
    }
  });

  test('P-T75 ① 환불 대기(REFUND_ACCOUNT_PENDING) 건은 대상 취소 ID로 열리고 같은 취소의 환급 실패 건과 다른 건이다', async () => {
    const pending = FIXTURE.cases.find((c) => c.body.kind === 'REFUND_ACCOUNT_PENDING')!;
    const store = new MemoryCsCaseStore();
    const controller = new CasesController(new ReceiveCaseRequested(store), fakeClock({ now: FIXTURE.nowMs }));
    const a = await controller.create(pending.body);
    const b = await controller.create({ ...pending.body, kind: 'REFUND_FAILED', eventKey: pending.body.sourceId });
    expect(a.accepted).toBe(true);
    expect(b.accepted).toBe(true);
    expect(a.caseId).not.toBe(b.caseId);
    expect(store.cases.size).toBe(2);
  });
});
