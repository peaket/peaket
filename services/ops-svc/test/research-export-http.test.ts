// F-04-19 연구 내보내기 HTTP 시험(동결 로컬, LCH-330·LCH-340).
// 정본: docs/features/forensic-replay.md §6.1·§6.3·§6.4·§6.6·§8(FX-T10·T17·T21),
// docs/features/analytics.md §6.3(A-T23), docs/security/asvs/forensic-replay.md 1.2.4·2.2.3·2.3.1·2.4.1·
// 3.2.1·3.5.3·4.1.1·5.4.1·8.2.1·8.2.2·8.2.3·13.2.2·14.2.4·16.2.1·16.2.5·16.3.2·16.3.3.
// 기준 트리에서는 새 경로가 없어 404로 단언 실패한다. 구현이 경로를 열면 아래 단언이 판정한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const EVENT = '0194b240-0000-7000-8000-000000000101';
const OLD = '0194b240-0000-7000-8000-000000000102';
const COLUMNS = [
  't_ms', 'kind', 'seat', 'section', 'session', 'result', 'retry', 'latency_ms',
  'first_hold_ms', 'entropy', 'net_type', 'asn', 'device_group', 'bot_tier', 'member', 'post_seat',
];
const ARROW = new TextEncoder().encode(`ARROW1${'0'.repeat(16)}ARROW1`);

type Req = { statusCode: number; payload: string; headers: Record<string, string | string[] | undefined>; rawPayload?: Buffer };
const json = (r: Req): Record<string, any> => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, any>));
const problemType = (r: Req) => String(json(r).type ?? '').replace(/^.*\//, '');
const header = (r: Req, name: string) => {
  const found = Object.entries(r.headers).find(([k]) => k.toLowerCase() === name);
  return found ? String(found[1]) : undefined;
};

class StoreFake {
  readonly map = new Map<string, any>();
  readonly denials: Array<{ accountId: string; atMs: number; problemType: string }> = [];
  async put(r: any) { this.map.set(r.exportId, { ...r }); }
  async get(id: string) { return this.map.get(id) ?? null; }
  async update(r: any) { this.map.set(r.exportId, { ...r }); }
  async listPending(nowMs: number, limit: number) {
    return [...this.map.values()].filter((r) => r.status === 'PENDING' && r.expiresAtMs > nowMs).slice(0, limit);
  }
  async countCreatedBetween(i: { accountId: string; fromMs: number; toMs: number }) {
    return [...this.map.values()].filter((r) => r.createdBy === i.accountId && r.createdAtMs >= i.fromMs && r.createdAtMs < i.toMs).length;
  }
  async recordDenial(i: { accountId: string; atMs: number; problemType: string }) { this.denials.push(i); }
  async countDeniedSince(i: { accountId: string; sinceMs: number }) {
    return this.denials.filter((d) => d.accountId === i.accountId && d.atMs >= i.sinceMs).length;
  }
}

class BufferFake {
  readonly map = new Map<string, { bytes: Uint8Array; expiresAtMs: number }>();
  async put(exportId: string, bytes: Uint8Array, expiresAtMs: number) { this.map.set(exportId, { bytes, expiresAtMs }); }
  async get(exportId: string, nowMs: number) {
    const v = this.map.get(exportId);
    return v && v.expiresAtMs > nowMs ? v.bytes : null;
  }
}

const store = new StoreFake();
const buffer = new BufferFake();
const silver = {
  calls: [] as Array<{ eventId: string; fromMs: number; toMs: number }>,
  async build(i: { eventId: string; fromMs: number; toMs: number }) {
    this.calls.push({ ...i });
    return { bytes: ARROW, rowCount: 7, columns: COLUMNS };
  },
};
const audit = { rows: [] as any[], async append(r: any) { this.rows.push(r); } };
const log = { rows: [] as any[], async append(r: any) { this.rows.push(r); } };
const alerts: any[] = [];
const config = { allowlistVersion: 'v1', approvedReviewVersions: ['v1'] as string[], keyVersion: 'analytics-v1' };
const schedule = {
  async get(eventId: string) {
    if (eventId === EVENT) return { opensAtMs: NOW - 10 * DAY, saleEndsAtMs: NOW - 9 * DAY };
    if (eventId === OLD) return { opensAtMs: NOW - 100 * DAY, saleEndsAtMs: NOW - 91 * DAY };
    return undefined;
  },
};

const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
let svc: Awaited<ReturnType<typeof createService>>;

function commander(designations: Array<'PSEUDONYM_HANDLER' | 'FRAUD_INVESTIGATOR' | 'ACCESS_REVIEWER'> = ['PSEUDONYM_HANDLER']) {
  const who = identity.ops('commander');
  admin.seed({ adminAccountId: who['x-user-id']!, role: 'commander', designations });
  return who;
}

const body = (o: Record<string, unknown> = {}) => ({ eventId: EVENT, fromMs: 0, toMs: 1_800_000, reason: '다음 회차 봇 판정 규칙 개선', ...o });
const post = (who: Record<string, string>, payload: unknown, idem = randomUUID()): Promise<Req> =>
  svc.http.inject({
    method: 'POST',
    url: '/v1/ops/research-exports',
    headers: { ...who, 'content-type': 'application/json', 'idempotency-key': idem },
    payload: JSON.stringify(payload),
  }) as unknown as Promise<Req>;
const get = (who: Record<string, string>, id: string, fetch: Record<string, string> = { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }): Promise<Req> =>
  svc.http.inject({ method: 'GET', url: `/v1/ops/research-exports/${id}`, headers: { ...who, ...fetch } }) as unknown as Promise<Req>;

/** 연구 모듈은 구현 전에는 없다. 파일이 없으면 null(단언 실패), 안쪽 import가 깨지면 오류를 던진다. */
async function researchModule(): Promise<Record<string, any> | null> {
  const url = new URL('../src/modules/research-exports/index.js', import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return (await import(/* @vite-ignore */ url.href)) as Record<string, any>;
}
const service = async () => {
  const mod = await researchModule();
  expect(mod, 'research-exports 모듈이 아직 없다').not.toBeNull();
  if (!mod) return null;
  return svc.app.get(mod.ResearchExports) as any;
};

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-research-export',
    module: AppModule.register({
      memory: true,
      adminAccounts: { identity: admin, reauth: kit.verifier },
      research: {
        store,
        buffer,
        silver,
        audit,
        log,
        config,
        alerts: { raise: async (i: any) => void alerts.push(i) },
        schedule,
        now: () => clock.now(),
      },
    } as any),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: 'f0419-internal-token' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => { await svc?.close(); });

beforeEach(() => {
  clock.advance(NOW - clock.now());
  store.map.clear();
  store.denials.length = 0;
  buffer.map.clear();
  silver.calls.length = 0;
  audit.rows.length = 0;
  log.rows.length = 0;
  alerts.length = 0;
  config.allowlistVersion = 'v1';
  config.approvedReviewVersions = ['v1'];
});

describe('F-04-19 연구 내보내기 HTTP', () => {
  test('FX-T10 ① A-T23 ② [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-16.3.2] 지정이 없거나 조사관 지정과 겹치면 403 pseudonym-handler-required이고 거절이 남는다', async () => {
    for (const designations of [[], ['FRAUD_INVESTIGATOR'], ['PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR']] as const) {
      const who = commander([...designations] as any);
      const r = await post(who, body());
      expect(r.statusCode, r.payload).toBe(403);
      expect(problemType(r), r.payload).toBe('pseudonym-handler-required');
    }
    expect(store.map.size).toBe(0);
    expect(audit.rows.filter((r) => r.payload?.outcome === 'DENIED')).toHaveLength(3);
    expect(log.rows.filter((r) => r.usage?.outcome === 'DENIED')).toHaveLength(3);
    for (const row of log.rows) expect(row.purpose).toBe('SCIENTIFIC_RESEARCH');
  });

  test('FX-T10 ② A-T23 ③ [ASVS v5.0.0-2.3.1] 검토 결과서가 승인되지 않은 판이면 403 pseudonymization-review-pending이다', async () => {
    const who = commander();
    config.approvedReviewVersions = [];
    const r1 = await post(who, body());
    expect(r1.statusCode, r1.payload).toBe(403);
    expect(problemType(r1), r1.payload).toBe('pseudonymization-review-pending');
    config.approvedReviewVersions = ['v0'];
    const r2 = await post(who, body());
    expect(r2.statusCode, r2.payload).toBe(403);
    expect(problemType(r2), r2.payload).toBe('pseudonymization-review-pending');
    expect(store.map.size).toBe(0);
    expect(log.rows.filter((r) => r.usage?.outcome === 'DENIED')).toHaveLength(2);
  });

  test('FX-T10 ③ [ASVS v5.0.0-2.2.3] 시간창이 틀리면 422이고 내보내기·성공 감사 줄이 없다', async () => {
    const who = commander();
    const bads = [body({ toMs: 1_800_001 }), body({ fromMs: -1 }), body({ fromMs: 5, toMs: 5 }), body({ fromMs: 9, toMs: 1 })];
    for (const b of bads) {
      const r = await post(who, b);
      expect(r.statusCode, r.payload).toBe(422);
      expect(problemType(r), r.payload).toBe('about:blank');
    }
    expect(store.map.size).toBe(0);
    expect(audit.rows.filter((r) => r.payload?.outcome === 'DENIED')).toHaveLength(4);
    expect(audit.rows.filter((r) => r.payload?.outcome === 'REQUESTED')).toHaveLength(0);
  });

  test('FX-T10 ④ [ASVS v5.0.0-2.2.3] 보존이 지난 회차는 422이고 내보내지 않는다', async () => {
    const who = commander();
    const r = await post(who, body({ eventId: OLD }));
    expect(r.statusCode, r.payload).toBe(422);
    expect(problemType(r), r.payload).toBe('about:blank');
    expect(store.map.size).toBe(0);
    expect(log.rows.filter((r) => r.usage?.outcome === 'DENIED')).toHaveLength(1);
  });

  test('FX-T10 ⑤ [ASVS v5.0.0-2.4.1] UTC 하루 5회를 넘으면 429 Retry-After이고 여섯 번째는 만들지 않는다', async () => {
    const who = commander();
    for (let n = 0; n < 5; n += 1) {
      const r = await post(who, body());
      expect(r.statusCode, r.payload).toBe(202);
      expect(json(r).status).toBe('PENDING');
    }
    const sixth = await post(who, body());
    expect(sixth.statusCode, sixth.payload).toBe(429);
    expect(header(sixth, 'retry-after')).toMatch(/^\d+$/);
    expect(store.map.size).toBe(5);
    clock.advance(DAY);
    const next = await post(who, body());
    expect(next.statusCode, next.payload).toBe(202);
    expect(store.map.size).toBe(6);
  });

  test('FX-T10 ⑥ [ASVS v5.0.0-16.2.1] [ASVS v5.0.0-14.2.4] 성공·받기·거절이 감사와 pseudonymization_log에 남고 STATISTICS와 섞이지 않는다', async () => {
    const who = commander();
    log.rows.push({ purpose: 'STATISTICS', usage: { outcome: 'LOADED' } });
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    const got = await get(who, id);
    expect(got.statusCode, got.payload).toBe(200);

    const research = log.rows.filter((r) => r.purpose === 'SCIENTIFIC_RESEARCH');
    expect(research.map((r) => r.usage.outcome)).toEqual(['REQUESTED', 'READY', 'RECEIVED']);
    for (const r of research) expect(r.usage.rowCount).toBeGreaterThanOrEqual(0);
    expect(log.rows[0]).toMatchObject({ purpose: 'STATISTICS' });
    expect(audit.rows.map((r) => r.payload.outcome)).toEqual(['REQUESTED', 'READY', 'RECEIVED']);
    for (const row of audit.rows) {
      expect(row.recordType).toBe('RESEARCH_EXPORT');
      expect(row.payload.accountId).toBe(who['x-user-id']);
      expect(row.payload.eventId).toBe(EVENT);
      expect(row.payload.reason).toBe('다음 회차 봇 판정 규칙 개선');
    }
  });

  test('FX-T10 ⑦⑧ [ASVS v5.0.0-3.2.1] [ASVS v5.0.0-4.1.1] [ASVS v5.0.0-5.4.1] 받은 파일은 Arrow content-type·no-store·Content-Disposition 없음이고 navigate·cross-site는 403이다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());

    const ok = await get(who, id);
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(String(header(ok, 'content-type')).toLowerCase()).toContain('application/vnd.apache.arrow.file');
    expect(String(header(ok, 'cache-control')).toLowerCase()).toContain('no-store');
    expect(header(ok, 'content-disposition')).toBeUndefined();
    expect(Buffer.from(ok.rawPayload ?? [])).toEqual(Buffer.from(ARROW));

    const fetches: Array<Record<string, string>> = [
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' },
      {},
    ];
    for (const fetch of fetches) {
      const denied = await get(who, id, fetch);
      expect(denied.statusCode, denied.payload).toBe(403);
    }
    expect(store.map.get(id)?.status).toBe('READY');
  });

  test('FX-T10 ⑨ [ASVS v5.0.0-8.2.2] 만든 세션만 받고 준비 중이면 409 Retry-After다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);

    const early = await get(who, id);
    expect(early.statusCode, early.payload).toBe(409);
    expect(problemType(early), early.payload).toBe('research-export-not-ready');
    expect(header(early, 'retry-after')).toMatch(/^\d+$/);

    const otherSession = randomUUID();
    identity.answers.set(`${who['x-user-id']}/${otherSession}`, { valid: true, role: 'commander' });
    const bySession = await get({ ...who, 'x-session-id': otherSession }, id);
    expect(bySession.statusCode, bySession.payload).toBe(403);

    const otherAccount = commander();
    const byAccount = await get(otherAccount, id);
    expect(byAccount.statusCode, byAccount.payload).toBe(403);
  });

  test('FX-T10 ⑩ 같은 Idempotency-Key는 같은 exportId를 만들고 한도·감사·이용 내역을 두 번 세지 않는다', async () => {
    const who = commander();
    const key = randomUUID();
    const a = await post(who, body(), key);
    const b = await post(who, body(), key);
    expect(a.statusCode, a.payload).toBe(202);
    expect(b.statusCode, b.payload).toBe(202);
    expect(json(a).exportId).toBe(json(b).exportId);
    expect(store.map.size).toBe(1);
    expect(audit.rows.filter((r) => r.payload?.outcome === 'REQUESTED')).toHaveLength(1);
    expect(log.rows.filter((r) => r.usage?.outcome === 'REQUESTED')).toHaveLength(1);
  });

  test('A-T23 ① [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2] 지정 commander가 만들고 받는 흐름이 202→409→200이고 이용 내역이 남는다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    expect(created.statusCode).toBe(202);
    expect(json(created)).toMatchObject({ eventId: EVENT, status: 'PENDING' });
    expect(json(created).createdAt).toBeTruthy();
    expect((await get(who, id)).statusCode).toBe(409);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    const got = await get(who, id);
    expect(got.statusCode, got.payload).toBe(200);
    expect(Buffer.from(got.rawPayload ?? [])).toEqual(Buffer.from(ARROW));
    expect(log.rows.map((r) => r.usage.outcome)).toEqual(['REQUESTED', 'READY', 'RECEIVED']);
  });

  test('FX-T17 ③ [ASVS v5.0.0-8.2.3] 실버에는 회차·시간창만 넘기고 조사 칸·원문 IP를 넘기지 않는다', async () => {
    const who = commander();
    const created = await post(who, body({ fromMs: 10, toMs: 20 }));
    expect(created.statusCode, created.payload).toBe(202);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    expect(silver.calls).toHaveLength(1);
    expect(silver.calls[0]).toEqual({ eventId: EVENT, fromMs: 10, toMs: 20 });
    const text = JSON.stringify(silver.calls[0]);
    for (const bad of ['accountId', 'journeyId', 'deviceRef', 'contactRef', 'paymentMethodRef', 'cardBin', 'ip', 'behavior']) {
      expect(text, bad).not.toContain(bad);
    }
  });

  test('FX-T21 ⑤ [ASVS v5.0.0-3.2.1] 받기 응답은 no-store·Arrow content-type·Content-Disposition 없음이고 주소창 열기는 403이다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    const ok = await get(who, id);
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(String(header(ok, 'content-type')).toLowerCase()).toContain('application/vnd.apache.arrow.file');
    expect(String(header(ok, 'cache-control')).toLowerCase()).toContain('no-store');
    expect(header(ok, 'content-disposition')).toBeUndefined();
    const nav = await get(who, id, { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' });
    expect(nav.statusCode, nav.payload).toBe(403);
  });

  test('FX-T21 ⑥ [ASVS v5.0.0-2.3.1] 준비 중이면 409 research-export-not-ready와 Retry-After다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const early = await get(who, String(json(created).exportId));
    expect(early.statusCode, early.payload).toBe(409);
    expect(problemType(early), early.payload).toBe('research-export-not-ready');
    expect(header(early, 'retry-after')).toMatch(/^\d+$/);
  });

  test('FX-T10 ⑫ [ASVS v5.0.0-16.3.3] 같은 계정 403이 10분 안에 3번이면 보안 경보를 한 번 낸다', async () => {
    const who = commander();
    config.approvedReviewVersions = [];
    for (let n = 0; n < 2; n += 1) expect((await post(who, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(0);
    expect((await post(who, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'RESEARCH_EXPORT_DENIALS', accountId: who['x-user-id'], count: 3 });
    expect((await post(who, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(1);

    clock.advance(600_001);
    expect((await post(who, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(1);
  });
});
