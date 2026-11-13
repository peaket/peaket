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
});
