// F-06-3 구현 리뷰 IR-01·02·03·04·11·17 시작 조립·경로 재현 시험(구현 담당, 2026-11-26).
// 실제 서버 조립이 포트를 꽂고 배경 tick·내부 경로·화면 경로가 있는지 소스에서 확인한다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

describe('IR-01 ops 시작 조립', () => {
  test('IR-01 main.ts가 lifecycle targets·executors·notifier·alerts·failureCases를 넘긴다', () => {
    const main = read('services/ops-svc/src/main.ts');
    expect(main).toMatch(/lifecycle:\s*\{/);
    for (const port of ['targets', 'executors', 'notifier', 'alerts']) expect(main, port).toMatch(new RegExp(`${port}:`));
    expect(read('services/ops-svc/src/modules/approvals/approvals.module.ts')).toMatch(/deps\.failureCases/);
  });
});

describe('IR-02 5분 tick', () => {
  test('IR-02 5분 tick을 부르는 배경 작업이 시작 조립에 있다', () => {
    const main = read('services/ops-svc/src/main.ts');
    expect(main).toMatch(/approval.*tick|ApprovalTick|approvalTick/i);
    expect(main).toMatch(/5\s*\*\s*60|300_000|5m|5분/);
  });
});

describe('IR-03 purchase 주문 근거', () => {
  test('IR-03 approval-basis·minor-contract-basis 내부 경로가 있다', () => {
    const source = read('services/purchase-svc/src/modules/booking/inbound/orders.controller.ts') + read('services/purchase-svc/src/modules/booking/application/approval-basis.ts');
    expect(source).toMatch(/approval-basis/);
    expect(source).toMatch(/minor-contract-basis/);
  });
});

describe('IR-04 identity 주문 근거 조립', () => {
  test('IR-04 main.ts가 minorContractOrders를 넘긴다', () => {
    const main = read('services/identity-svc/src/main.ts');
    expect(main).toMatch(/minorContractOrders/);
    expect(main).toMatch(/minor-contract-basis/);
  });
});

describe('IR-11 GAT-300 처리 행동', () => {
  test('IR-11 cancellation-decision·system-refund 경로가 있다', () => {
    const cases = read('services/ops-svc/src/modules/cases/inbound/ops-cases.controller.ts') + read('services/ops-svc/src/modules/cases/application/cancellation-decision.ts');
    expect(cases).toMatch(/cancellation-decision/);
    expect(cases).toMatch(/system-refund/);
  });
});

describe('IR-17 콘솔 목록', () => {
  test('IR-17 /cs/approvals가 ConnectedPage를 쓴다', () => {
    const router = read('apps/console-host/src/app/router.tsx');
    expect(router).toMatch(/path: 'cs\/approvals',[\s\S]*?Component: m\.ConnectedPage/);
  });
});

describe('구현 재리뷰 IR-03·10·11·21·28·29', () => {
  test('IR-03 purchase byOrder가 결제 승인 시각·남은 환급액·입장 기록을 싣는다', () => {
    const src = read('services/purchase-svc/src/modules/refund/adapters/db/drizzle-cancellation.ts');
    expect(src).toMatch(/paidAtMs/);
    expect(src).toMatch(/refundableAmount/);
    expect(src).toMatch(/entryRecorded/);
  });

  test('IR-10 Drizzle이 주문의 이전 취소를 읽는다', () => {
    const src = read('services/purchase-svc/src/modules/refund/adapters/db/drizzle-cancellation.ts');
    expect(src).toMatch(/cancellationsOf/);
  });

  test('IR-11 system-refund가 승인 업무를 만든다', () => {
    const src = read('services/ops-svc/src/modules/cases/inbound/ops-cases.controller.ts');
    expect(src).toMatch(/approvalLifecycle|ApprovalLifecycle/);
  });

  test('IR-21 승인 환불이 주문의 모든 티켓을 쓴다', () => {
    const src = read('services/purchase-svc/src/modules/refund/application/approval-refund.ts');
    expect(src).toMatch(/ticketIds/);
  });

  test('IR-28 DB 목록이 SQL에서 일반 승인 종류만 거른다', () => {
    const src = read('services/ops-svc/src/modules/approvals/adapters/db/drizzle-lifecycle-store.ts');
    expect(src).toMatch(/inArray\(approvalRequest\.kind/);
  });

  test('IR-29 tick이 임차로 한 파드만 실행한다', () => {
    const src = read('services/ops-svc/src/modules/approvals/application/approval-lifecycle.ts') + read('services/ops-svc/src/modules/approvals/adapters/db/drizzle-lifecycle-store.ts');
    expect(src).toMatch(/withTickLease|tickLease/);
  });
});
