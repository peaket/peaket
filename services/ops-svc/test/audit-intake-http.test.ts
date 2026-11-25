// 다른 서비스의 감사 기록 받기(BAT-355 OPS-270, ADR-0341 결정 7, POST /internal/v1/ops/audit-records).
// 내부 토큰이 없으면 거절, 허용 목록 밖 recordType·payload 칸(개인정보 칸 포함)은 400이고 아무것도 쓰지 않으며,
// 같은 eventKey는 체인 행 하나이고 처음 seq를 돌려주며 행위자는 SYSTEM(빈 UUID)이다. 받는 쪽 첫 값은 SHUFFLE_COMMIT_DISCLOSED다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-22T07:00:00.000Z');
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

const disclosure = (eventId: string, over: Record<string, unknown> = {}) => ({
  eventKey: `shuffle-commit:${eventId}:lobby:${'ab'.repeat(32)}`,
  recordType: 'SHUFFLE_COMMIT_DISCLOSED',
  recordId: eventId,
  payload: { eventId, group: 'lobby', commit: 'ab'.repeat(32), chain: 'quicknet', round: 1_234_567, algorithm: 'shuffle-v1' },
  occurredAt: new Date(NOW - 1_000).toISOString(),
  ...over,
});

describe('OPS-270 다른 서비스의 감사 기록 받기', () => {
  test('OPS-270 감사 기록 받기는 내부 토큰·허용 목록(recordType·payload 칸)을 지나야 하고, 같은 eventKey는 체인 행 하나이며 행위자는 SYSTEM이다', async () => {
    const token = `it-${randomUUID()}`;
    const h = await harness(token);
    const auth = { 'x-peaket-internal-token': token };
    const eventId = randomUUID();
    const good = disclosure(eventId);
    for (const [label, headers] of [
      ['토큰 없음', {}],
      ['틀린 토큰', { 'x-peaket-internal-token': `${token}x` }],
    ] as const) {
      const r = await h.post(headers, good);
      expect(r.statusCode, label).toBe(403);
    }
    // 허용 목록 밖 recordType마다, payload의 모르는 칸·사람을 가리키는 칸마다 400
    for (const [label, body] of [
      ['다른 recordType', disclosure(eventId, { recordType: 'COMMAND_CREATED' })],
      ['소문자 recordType', disclosure(eventId, { recordType: 'shuffle_commit_disclosed' })],
      ['감사 기록 위조', disclosure(eventId, { recordType: 'AUDIT_CHAIN_MISMATCH' })],
      ['계정 칸', disclosure(eventId, { payload: { ...good.payload, accountId: randomUUID() } })],
      ['이메일 칸', disclosure(eventId, { payload: { ...good.payload, email: 'fan@example.com' } })],
      ['커밋 꼴', disclosure(eventId, { payload: { ...good.payload, commit: 'XYZ' } })],
      ['행위자 칸', disclosure(eventId, { actorRef: randomUUID() })],
    ] as const) {
      const r = await h.post(auth, body);
      expect(r.statusCode, label).toBe(400);
    }
    expect(h.audit.entries).toEqual([]);
    const first = await h.post(auth, good);
    expect([first.statusCode, JSON.parse(first.payload)]).toEqual([202, { accepted: true, duplicate: false, seq: 1 }]);
    const again = await h.post(auth, { ...good, occurredAt: new Date(NOW).toISOString() });
    expect([again.statusCode, JSON.parse(again.payload)]).toEqual([202, { accepted: true, duplicate: true, seq: 1 }]);
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ seq: 1, recordType: 'SHUFFLE_COMMIT_DISCLOSED', recordId: eventId });
    expect(h.audit.entries[0]!.record.payload).toEqual({ ...good.payload, eventKey: good.eventKey, occurredAt: good.occurredAt, actorRef: SYSTEM_REF, actorRole: 'system' });
    const second = await h.post(auth, disclosure(eventId, { eventKey: `shuffle-commit:${eventId}:1:${'cd'.repeat(32)}`, payload: { ...good.payload, group: 1, commit: 'cd'.repeat(32) } }));
    expect(JSON.parse(second.payload)).toEqual({ accepted: true, duplicate: false, seq: 2 });
  });
});
