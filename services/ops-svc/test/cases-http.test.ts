// CS 처리함 내부 HTTP(BAT-425 GAT-130): purchase-svc 환급 실패 통지가 REFUND_FAILED 건을 열고 같은 대상은 멱등이다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-14T06:00:00.000Z');
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

const post = (body: unknown) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('/internal/v1/cs-cases', () => {
  test('GAT130_REFUND_FAILED_통지는_열린_건_하나를_만든다', async () => {
    const body = { eventKey: 'cancel-1', kind: 'REFUND_FAILED', sourceId: 'cancel-1', category: 'REFUND', createdAt: new Date(NOW).toISOString() };
    const a = await post(body);
    expect(a.statusCode).toBe(202);
    const first = JSON.parse(a.payload) as { accepted: boolean; caseId: string };
    expect(first.accepted).toBe(true);
    const b = await post({ ...body, eventKey: 'cancel-1-retry' });
    expect(JSON.parse(b.payload)).toEqual({ accepted: true, caseId: first.caseId });
  });

  test('GAT130_이_경로가_받지_않는_종류와_잘못된_본문은_건을_만들지_않는다', async () => {
    const body = { eventKey: 'inquiry-1', kind: 'INQUIRY', sourceId: 'inquiry-1', category: 'INQUIRY', createdAt: new Date(NOW).toISOString() };
    expect(JSON.parse((await post(body)).payload)).toEqual({ accepted: false });
    expect(JSON.parse((await post({ kind: 'REFUND_FAILED' })).payload)).toEqual({ accepted: false });
  });

  // BAT-420 GAT-090 A: purchase-svc 환급 실행기의 입장 기록 대조가 여는 이상 표시 건. 시험 담당이 구현 전에 썼다.
  test('GAT-090 A4 이상 표시 통지는 HTTP로 FLAGGED 건 하나를 열고 같은 취소의 다시 보냄은 같은 건이다', async () => {
    const cancellationId = '0194b000-0000-7000-8000-0000000a0003';
    const body = { eventKey: `entry-after-cancel:${cancellationId}`, kind: 'FLAGGED', sourceId: cancellationId, category: 'ENTRY_AFTER_CANCEL', createdAt: new Date(NOW).toISOString() };
    const a = await post(body);
    expect(a.statusCode).toBe(202);
    const first = JSON.parse(a.payload) as { accepted: boolean; caseId?: string };
    expect(first.accepted).toBe(true);
    expect(first.caseId).toEqual(expect.any(String));
    expect(JSON.parse((await post(body)).payload)).toEqual({ accepted: true, caseId: first.caseId });
  });

  // BAT-420 다시 보기 2 N2(시험 담당 l3w8-420-n-test, 2026-11-17): purchase-svc의 틱 끝 다시 열기는 같은 환급 실패 건을 같은 eventKey(취소 ID)로 다시 보낸다(멱등 대조)
  test('GAT-110 N2 같은 취소 ID의 REFUND_FAILED(category REFUND)를 두 번 받아도 둘 다 2xx이고 열린 건은 하나다', async () => {
    const cancellationId = '0194b000-0000-7000-8000-0000000a0420';
    const body = { eventKey: cancellationId, kind: 'REFUND_FAILED', sourceId: cancellationId, category: 'REFUND', createdAt: new Date(NOW).toISOString() };
    const a = await post(body);
    const b = await post(body);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    const first = JSON.parse(a.payload) as { accepted: boolean; caseId?: string };
    expect(first).toEqual({ accepted: true, caseId: expect.any(String) });
    expect(JSON.parse(b.payload)).toEqual({ accepted: true, caseId: first.caseId });
  });
});
