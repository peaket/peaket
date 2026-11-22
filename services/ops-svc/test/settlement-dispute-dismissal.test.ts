// J-T35 ④ 정산 이의 기각(ops 쪽, F-07-5 LCH-100, ADR-0368 결정 6, docs/features/settlement.md §4.2 '기각'·§13 J-T35 ④).
// cs_lead만 POST /v1/ops/settlements/{statementId}/dispute-dismissal을 부르고(cs_agent·viewer·operator·commander 403), 사유는 1~2,000자,
// payment-svc 4xx는 그대로·5xx는 503으로 전한다. 감사에는 사유 원문 대신 길이만 남긴다(사유 원문은 payment에만, 계획 I-05).
import { ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HttpPayoutPaymentClient } from '../src/modules/payouts/index.js';
import { opsSettlementFlow, type OpsRole, type OpsSettlementFlow } from './settlement-flow-support.js';

const NOW = Date.parse('2026-11-19T06:00:00.000Z');
let f: OpsSettlementFlow;
beforeEach(async () => {
  f = await opsSettlementFlow(NOW);
});
afterEach(async () => {
  await f.close();
  vi.unstubAllGlobals();
});

const dismiss = (statementId: string, headers: Record<string, string>, body: unknown) =>
  f.svc.http.inject({ method: 'POST', url: `/v1/ops/settlements/${statementId}/dispute-dismissal`, headers, payload: JSON.stringify(body) });

describe('J-T35 ④ 기각 역할·사유', () => {
  test('[ASVS v5.0.0-8.2.1] J-T35 ④ cs_lead만 기각하고 cs_agent·viewer·operator·commander는 403이며 payment를 부르지 않는다', async () => {
    const statementId = randomUUID();
    for (const role of ['cs_agent', 'viewer', 'operator', 'commander'] as const satisfies readonly OpsRole[]) {
      const res = await dismiss(statementId, f.headers(role), { reason: '원장과 같다' });
      expect({ role, code: res.statusCode }).toEqual({ role, code: 403 });
    }
    expect(f.payments.dismissed).toEqual([]);
    const lead = f.headers('cs_lead');
    const ok = await dismiss(statementId, lead, { reason: '  판매 대금은 원장과 같습니다  ' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(ok.payload)).toEqual({ statementId, status: 'NOTIFIED' });
    expect(f.payments.dismissed).toEqual([{ statementId, reason: '판매 대금은 원장과 같습니다', actorId: lead['x-user-id'] }]);
    const audits = f.audit.entries.filter((e) => e.recordType === 'SETTLEMENT_DISPUTE_DISMISSED');
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain('판매 대금은 원장과 같습니다');
  });

  test('J-T35 ④ 사유가 비거나 공백뿐이거나 2,001자면 400이고 2,000자는 받는다', async () => {
    const statementId = randomUUID();
    for (const reason of ['', '   ', '가'.repeat(2_001)]) {
      const res = await dismiss(statementId, f.headers('cs_lead'), { reason });
      expect({ len: reason.length, code: res.statusCode }).toEqual({ len: reason.length, code: 400 });
    }
    expect((await dismiss(statementId, f.headers('cs_lead'), {})).statusCode).toBe(400);
    expect(f.payments.dismissed).toEqual([]);
    expect((await dismiss(statementId, f.headers('cs_lead'), { reason: '가'.repeat(2_000) })).statusCode).toBe(200);
    expect(f.payments.dismissed).toHaveLength(1);
  });

  test('J-T35 ④ payment가 DISPUTED가 아니라 409면 409 그대로, 503이면 503이고 감사를 남기지 않는다', async () => {
    const statementId = randomUUID();
    f.payments.failNext.dismiss = new ProblemError({ type: 'settlement-not-disputed', status: 409, title: '이의 중인 정산서가 아닙니다' });
    const conflict = await dismiss(statementId, f.headers('cs_lead'), { reason: '사유' });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.payload).type).toContain('settlement-not-disputed');
    f.payments.failNext.dismiss = new ProblemError({ type: 'settlement-dependency-unavailable', status: 503, title: '정산 서비스에 연결하지 못했습니다' });
    expect((await dismiss(statementId, f.headers('cs_lead'), { reason: '사유' })).statusCode).toBe(503);
    expect(f.audit.entries.filter((e) => e.recordType === 'SETTLEMENT_DISPUTE_DISMISSED')).toEqual([]);
  });
});

describe('J-T35 ④(어댑터) payment 내부 기각 경로', () => {
  type Seen = { url: string; method: string; body: unknown; token: string | null };
  const stubFetch = (reply: () => Response | Promise<Response>) => {
    const seen: Seen[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, method: req.method, body: await req.json().catch(() => null), token: req.headers.get('x-peaket-internal-token') });
      return reply();
    });
    return seen;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('J-T35 ④ 기각은 payment 내부 dispute-dismissal로 사유·처리자를 보내고 4xx는 그 상태 그대로, 5xx·연결 실패는 503이다', async () => {
    const statementId = randomUUID();
    const actorId = randomUUID();
    const seen = stubFetch(() => json(200, { statementId, status: 'NOTIFIED' }));
    const client = new HttpPayoutPaymentClient('http://payment-svc:8080', 'internal-token');
    await expect(client.dismissDispute(statementId, { reason: '사유', actorId })).resolves.toEqual({ statementId, status: 'NOTIFIED' });
    expect(seen).toEqual([{ url: `http://payment-svc:8080/internal/v1/settlements/statements/${statementId}/dispute-dismissal`, method: 'POST', body: { reason: '사유', actorId }, token: 'internal-token' }]);

    stubFetch(() => json(409, { type: 'https://peaket.example/problems/settlement-not-disputed', status: 409, title: '이의 중이 아님' }));
    await expect(new HttpPayoutPaymentClient('http://payment-svc:8080', 'internal-token').dismissDispute(statementId, { reason: '사유', actorId })).rejects.toMatchObject({ status: 409 });
    stubFetch(() => json(500, {}));
    await expect(new HttpPayoutPaymentClient('http://payment-svc:8080', 'internal-token').dismissDispute(statementId, { reason: '사유', actorId })).rejects.toMatchObject({ status: 503 });
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(new HttpPayoutPaymentClient('http://payment-svc:8080', 'internal-token').dismissDispute(statementId, { reason: '사유', actorId })).rejects.toMatchObject({ status: 503 });
  });
});
