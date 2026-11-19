// P-T75 CS 건 어댑터의 계약(BAT-420-rest 리뷰 반영 RV-01, 시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/transfer-refund.md §3.1 ⑥ '실패 기록'(CS 건을 연 것은 ops-svc가 2xx로 답하고 본문이 accepted: true일 때뿐, 2xx accepted: false는 열기 실패와 같다),
// docs/features/payment.md §11 P-T75 ①~③. 어댑터 다섯 종류가 보내는 본문은 test/fixtures/cs-case-bodies.json과 정확히 같아야 하고,
// ops-svc 쪽 test/cases-contract.test.ts가 같은 본문을 실제 받는 층에 넣어 accepted: true와 건 하나를 본다(두 서비스가 한 파일을 읽는다).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlatformMetrics, type ExternalRequest } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CsCaseRejected, HttpDeductionGapNotice, HttpEntryFlagNotice, HttpRefundAccountNotice, HttpRefundFailureNotice, PromCsCaseSignals, RefundAfterEntry } from '../src/modules/refund/index.js';

interface Case {
  name: string;
  adapter: string;
  metricKind: string;
  input: Record<string, unknown>;
  body: Record<string, unknown>;
}
const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/cs-case-bodies.json', import.meta.url)), 'utf8')) as { nowMs: number; cases: Case[] };
const NOW = FIXTURE.nowMs;

/** 받은 요청을 적고 정한 답(상태·본문)을 주는 ops 대역 */
function opsDouble(answer: { status: number; body: string }) {
  const sent: ExternalRequest[] = [];
  const client = { request: async (r: ExternalRequest) => (sent.push(r), new Response(answer.body, { status: answer.status })) };
  return { sent, client };
}

/** 종류 이름 → 그 어댑터로 한 번 연다 */
function openWith(c: Case, client: { request(r: ExternalRequest): Promise<Response> }): Promise<void> {
  const i = c.input as Record<string, never>;
  switch (c.adapter) {
    case 'HttpEntryFlagNotice':
      return new HttpEntryFlagNotice(client, 'it-token').open({ cancellationId: i.cancellationId, orderId: i.orderId, ticketId: i.ticketId, enteredAtMs: i.enteredAtMs, nowMs: NOW });
    case 'HttpRefundFailureNotice':
      return new HttpRefundFailureNotice(client, 'it-token').open({ cancellationId: i.cancellationId, orderId: i.orderId, attempts: i.attempts, lastError: i.lastError, nowMs: NOW });
    case 'HttpRefundFailureNotice(event)':
      return new HttpRefundFailureNotice(client, 'it-token').open({ cancellationId: i.cancellationId, orderId: i.orderId, requestId: i.requestId, ticketId: i.ticketId, attempts: i.attempts, lastError: i.lastError, nowMs: NOW });
    case 'HttpDeductionGapNotice':
      return new HttpDeductionGapNotice(client, 'it-token').open({ cancellationId: i.cancellationId, orderId: i.orderId, deductionAmount: i.deductionAmount, requestId: i.requestId, nowMs: NOW });
    case 'HttpRefundAccountNotice':
      return new HttpRefundAccountNotice(client, 'it-token').open({ cancellationId: i.cancellationId, orderId: i.orderId, nowMs: NOW });
    default:
      throw new Error(`모르는 어댑터 ${c.adapter}`);
  }
}

describe('P-T75 CS 건 어댑터 다섯 종류의 본문과 accepted 판정', () => {
  test('P-T75 ① 어댑터 다섯이 보내는 본문은 공용 표(cs-case-bodies.json)와 정확히 같다(경로·내부 토큰·5초 상한)', async () => {
    expect(FIXTURE.cases.map((c) => c.metricKind)).toEqual(['FLAGGED', 'REFUND_FAILED', 'EVENT_REFUND_FAILED', 'DEDUCTION_GAP', 'REFUND_ACCOUNT_PENDING']);
    for (const c of FIXTURE.cases) {
      const ops = opsDouble({ status: 202, body: '{"accepted":true,"caseId":"0193a000-0000-7000-8000-0000000aaaaa"}' });
      await expect(openWith(c, ops.client), c.name).resolves.toBeUndefined();
      expect(ops.sent, c.name).toHaveLength(1);
      expect(ops.sent[0], c.name).toMatchObject({ method: 'POST', path: '/internal/v1/cs-cases', timeoutCapMs: 5_000, headers: expect.objectContaining({ 'x-peaket-internal-token': 'it-token' }) });
      expect(JSON.parse(String(ops.sent[0]!.body)), c.name).toEqual(c.body);
    }
  });

  test('P-T75 ③ 2xx라도 본문이 accepted: true가 아니면(accepted: false, 칸 없음, JSON 아님) 어댑터 다섯 모두 CsCaseRejected로 던진다', async () => {
    for (const c of FIXTURE.cases) {
      for (const answer of [
        { status: 202, body: '{"accepted":false}' },
        { status: 200, body: '{"accepted":false}' },
        { status: 202, body: '{}' },
        { status: 202, body: 'not-json' },
      ]) {
        const err = await openWith(c, opsDouble(answer).client).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err, `${c.name} ${answer.status} ${answer.body}`).toBeInstanceOf(CsCaseRejected);
      }
      // 대조: 2xx 밖은 지금처럼 던진다
      await expect(openWith(c, opsDouble({ status: 500, body: '{}' }).client), `${c.name} 500`).rejects.toBeInstanceOf(CsCaseRejected);
    }
  });

  test('P-T75 ② ops-svc가 2xx accepted: false로 답하면 틱 끝 다시 열기는 연 시각을 쓰지 않고 지표 purchase_cs_case_open_failures_total{kind="REFUND_ACCOUNT_PENDING"}를 1 올리며 다음 틱에 다시 부른다', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const signals = new PromCsCaseSignals().register(metrics.registry);
    const pendingCase = FIXTURE.cases.find((c) => c.metricKind === 'REFUND_ACCOUNT_PENDING')!;
    const id = pendingCase.input.cancellationId as string;
    const opened: string[] = [];
    let answer = { status: 202, body: '{"accepted":false}' };
    const sent: ExternalRequest[] = [];
    const client = { request: async (r: ExternalRequest) => (sent.push(r), new Response(answer.body, { status: answer.status })) };
    const runner = new RefundAfterEntry({
      nowMs: () => NOW,
      writes: { dueRefunds: async () => [], updateStatus: async () => undefined, scheduleRefundRetry: async () => undefined, markRefundFailed: async () => undefined } as never,
      payments: { cancel: async () => 'CANCELLED' },
      entries: { lookup: async () => new Map() },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      accountNotice: new HttpRefundAccountNotice(client, 'it-token'),
      csOutbox: {
        pendingFlags: async () => [],
        markFlagOpened: async () => undefined,
        pendingRefundFailures: async () => [],
        markRefundFailureOpened: async () => undefined,
        pendingRefundAccounts: async () => (opened.includes(id) ? [] : [{ cancellationId: id, orderId: pendingCase.input.orderId as string }]),
        markRefundAccountOpened: async (cid: string) => void opened.push(cid),
      },
      csCaseOpenFailures: signals,
      log: { warn: () => undefined, error: () => undefined },
    });
    const metric = async () => {
      const line = (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith('purchase_cs_case_open_failures_total{kind="REFUND_ACCOUNT_PENDING"}'));
      return Number(line?.split(' ').at(-1) ?? Number.NaN);
    };
    expect(await metric()).toBe(0);
    await runner.run();
    // 장애 주입이 끼어들었다: ops 대역이 한 번 받았고 accepted: false로 답했다
    expect(sent).toHaveLength(1);
    expect(opened).toEqual([]);
    expect(await metric()).toBe(1);
    await runner.run();
    expect(sent).toHaveLength(2);
    expect(opened).toEqual([]);
    expect(await metric()).toBe(2);
    // 받는 쪽이 accepted: true로 답하면 그때 연 시각을 쓰고 더 부르지 않는다
    answer = { status: 202, body: '{"accepted":true,"caseId":"0193a000-0000-7000-8000-0000000aaaab"}' };
    await runner.run();
    expect(opened).toEqual([id]);
    await runner.run();
    expect(sent).toHaveLength(3);
  });
});
