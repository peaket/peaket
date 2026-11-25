// F-02-4 관리 계정 접속기록(2년 보존)과 접속기록 파기 기록의 감사 접수 시험.
// 정본: docs/security/data-classification.md '관리자 시스템 접속기록'·'백업 보존 상한과 파기',
// docs/observability.md §7 '불변 감사 로그 격리'. 같은 eventKey는 체인 행 하나이고 행위자는 SYSTEM이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-24T07:00:00.000Z');
const SYSTEM_REF = '00000000-0000-0000-0000-000000000000';
const opened: Array<Awaited<ReturnType<typeof createService>>> = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
  vi.unstubAllEnvs();
});

async function harness(token: string) {
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
  const post = (headers: Record<string, string>, body: unknown) =>
    svc.http.inject({ method: 'POST', url: '/internal/v1/ops/audit-records', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  return { audit, post };
}

const adminAccess = (over: Record<string, unknown> = {}) => {
  const recordId = randomUUID();
  return {
    eventKey: `access-log-admin:v1:2026-11-23:identity:${recordId}`,
    recordType: 'ADMIN_ACCESS_LOG',
    recordId,
    payload: {
      source: 'identity',
      accessTs: '2026-11-23T12:00:00.000Z',
      requestId: 'req-1',
      event: 'LOGIN',
      result: 'SUCCESS',
      provider: 'PASSWORD',
      factors: ['password', 'totp'],
      failure: '',
      clientIp: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      adminAccountId: '11111111-1111-4111-8111-111111111111',
      pod: 'identity-1',
      seq: 1,
      retainUntil: '2028-11-23T12:00:00.000Z',
    },
    occurredAt: '2026-11-23T12:00:00.000Z',
    ...over,
  };
};

const purge = (over: Record<string, unknown> = {}) => {
  const recordId = randomUUID();
  return {
    eventKey: `access-log-purge:v1:2026-08-22:access_log:${recordId}`,
    recordType: 'ACCESS_LOG_PARTITION_PURGE',
    recordId,
    payload: { day: '2026-08-22', table: 'access_log', state: 'DROPPED', rows: 7, reconciled: false, reason: null },
    occurredAt: '2026-11-24T20:00:00.000Z',
    ...over,
  };
};

describe('F-02-4 접속기록 파기·관리 계정 접속기록 감사 접수', () => {
  test('[ASVS v5.0.0-16.4.3] 관리 계정 접속기록을 SYSTEM 행위자로 한 번만 받고 2년 보존 끝을 보존한다', async () => {
    const token = `it-${randomUUID()}`;
    const h = await harness(token);
    const auth = { 'x-peaket-internal-token': token };
    const good = adminAccess();
    const first = await h.post(auth, good);
    expect(first.statusCode).toBe(202);
    expect(JSON.parse(first.payload)).toEqual({ accepted: true, duplicate: false, seq: 1 });
    const again = await h.post(auth, good);
    expect(JSON.parse(again.payload)).toEqual({ accepted: true, duplicate: true, seq: 1 });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ seq: 1, recordType: 'ADMIN_ACCESS_LOG', recordId: good.recordId });
    expect(h.audit.entries[0]!.record.payload).toMatchObject({
      ...good.payload,
      eventKey: good.eventKey,
      occurredAt: good.occurredAt,
      actorRef: SYSTEM_REF,
      actorRole: 'system',
    });
  });

  test('[ASVS v5.0.0-16.4.2] 관리 계정 접속기록에 비밀번호·토큰·쿠키·본문·연락처 칸이 있으면 400이고 아무것도 쓰지 않는다', async () => {
    const token = `it-${randomUUID()}`;
    const h = await harness(token);
    const auth = { 'x-peaket-internal-token': token };
    const good = adminAccess();
    const accepted = await h.post(auth, good);
    expect(accepted.statusCode).toBe(202);
    for (const [label, extra] of [
      ['비밀번호', { password: 'hunter2' }],
      ['토큰', { token: 'tok' }],
      ['쿠키', { cookie: 'sid=1' }],
      ['본문', { body: '{"a":1}' }],
      ['이메일', { email: 'admin@example.com' }],
    ] as const) {
      const r = await h.post(auth, adminAccess({ payload: { ...good.payload, ...extra } }));
      expect(r.statusCode, label).toBe(400);
    }
    expect(h.audit.entries).toHaveLength(1);
  });

  test('[ASVS v5.0.0-14.2.4] 파기 계획·결과를 받고 모르는 상태·표는 거절한다', async () => {
    const token = `it-${randomUUID()}`;
    const h = await harness(token);
    const auth = { 'x-peaket-internal-token': token };
    for (const state of ['PLANNED', 'DROPPED', 'FAILED']) {
      const r = await h.post(auth, purge({ payload: { ...purge().payload, state } }));
      expect(r.statusCode, state).toBe(202);
    }
    for (const [label, body] of [
      ['모르는 상태', purge({ payload: { ...purge().payload, state: 'DELETED' } })],
      ['모르는 표', purge({ payload: { ...purge().payload, table: 'access_log_admin' } })],
      ['날짜 꼴', purge({ payload: { ...purge().payload, day: '2026-8-2' } })],
    ] as const) {
      const before = h.audit.entries.length;
      const r = await h.post(auth, body);
      expect(r.statusCode, label).toBe(400);
      expect(h.audit.entries.length, label).toBe(before);
    }
    expect(h.audit.entries.filter((e) => e.recordType === 'ACCESS_LOG_PARTITION_PURGE')).toHaveLength(3);
  });
});
