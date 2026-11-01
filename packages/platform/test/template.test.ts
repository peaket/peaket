// 서비스 안 구조 뼈대(template/)가 그대로 뜨는지 본다(docs/architecture.md §3.1, 기술 검토 낮음-008,
// openspec 변경 add-service-structure-and-request-checks 결정 1). 받는 층 → 유스케이스 → 도메인 → 포트 → 어댑터.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../template/src/app.module.js';
import { createService, fakeClock } from '../src/index.js';
import { collector } from './fixture.js';

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'example-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream });
});
afterAll(async () => {
  await svc.close();
});

const me = (account = 'acc-1') => ({ 'x-user-id': account, 'x-session-id': `s-${account}`, 'x-user-aud': 'fan', 'content-type': 'application/json' });
/** 쓰기 요청은 멱등 키가 있어야 한다(FND-080) */
const write = (account = 'acc-1', key: string = randomUUID()) => ({ ...me(account), 'idempotency-key': key });

describe('서비스 뼈대', () => {
  test('낮음008_뼈대서비스가떠서_만들고읽는요청이_층을지나200이다', async () => {
    const created = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write(), payload: JSON.stringify({ title: '  첫 메모 ' }) });
    expect(created.statusCode).toBe(201);
    const { id, title } = JSON.parse(created.payload) as { id: string; title: string };
    expect(title).toBe('첫 메모');
    const read = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}`, headers: me() });
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.payload)).toEqual({ id, title: '첫 메모' });
  });

  test('낮음008_도메인규칙의거절은422이고_남의메모는404다', async () => {
    const bad = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write(), payload: JSON.stringify({ title: 'x'.repeat(51) }) });
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.payload)).toMatchObject({ type: 'https://peaket.example/problems/note-title-invalid', reason: 'title-too-long' });
    const created = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write('acc-1'), payload: JSON.stringify({ title: '내 것' }) });
    const { id } = JSON.parse(created.payload) as { id: string };
    const other = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}`, headers: me('acc-2') });
    expect(other.statusCode).toBe(404);
    const anon = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}` });
    expect(anon.statusCode).toBe(401);
  });

  test('FND080_뼈대의쓰기경로는_같은키로다시보내면같은메모이고_본문이다르면422_키가없으면400이다', async () => {
    const key = randomUUID();
    const body = JSON.stringify({ title: '한 번만' });
    const a = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write('acc-9', key), payload: body });
    const b = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write('acc-9', key), payload: body });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(JSON.parse(b.payload)).toEqual(JSON.parse(a.payload));
    const other = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write('acc-9', key), payload: JSON.stringify({ title: '다른 본문' }) });
    expect(other.statusCode).toBe(422);
    expect(JSON.parse(other.payload)).toMatchObject({ type: 'https://peaket.example/problems/idempotency-key-reused' });
    const noKey = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: me('acc-9'), payload: body });
    expect(JSON.parse(noKey.payload)).toMatchObject({ status: 400, type: 'https://peaket.example/problems/idempotency-key-invalid' });
    // 다른 계정의 같은 키는 따로 처리한다
    const mine = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: write('acc-8', key), payload: body });
    expect((JSON.parse(mine.payload) as { id: string }).id).not.toBe((JSON.parse(a.payload) as { id: string }).id);
  });
});
