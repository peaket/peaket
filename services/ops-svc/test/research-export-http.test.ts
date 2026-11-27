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
const HALF_HOUR = 1_800_000;
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
  failNextGet = false;
  failNextPut = false;
  failNextUpdate = false;
  countDelayMs = 0;
  async put(r: any) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('store put down');
    }
    this.map.set(r.exportId, { ...r });
  }
  async get(id: string) {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('store get down');
    }
    return this.map.get(id) ?? null;
  }
  async update(r: any) {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('store update down');
    }
    this.map.set(r.exportId, { ...r });
  }
  async delete(id: string) { this.map.delete(id); }
  async deleteExpired(nowMs: number) {
    let deleted = 0;
    for (const [id, r] of this.map) {
      if (r.expiresAtMs <= nowMs) {
        this.map.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
  async listPending(nowMs: number, limit: number) {
    return [...this.map.values()].filter((r) => r.status === 'PENDING' && r.expiresAtMs > nowMs).slice(0, limit);
  }
  async countCreatedBetween(i: { accountId: string; fromMs: number; toMs: number }) {
    if (this.countDelayMs > 0) await new Promise((r) => setTimeout(r, this.countDelayMs));
    return [...this.map.values()].filter((r) => r.createdBy === i.accountId && r.createdAtMs >= i.fromMs && r.createdAtMs < i.toMs).length;
  }
  async recordDenial(i: { accountId: string; atMs: number; problemType: string }) { this.denials.push(i); }
  async countDeniedSince(i: { accountId: string; sinceMs: number }) {
    return this.denials.filter((d) => d.accountId === i.accountId && d.atMs >= i.sinceMs).length;
  }
}

class BufferFake {
  readonly map = new Map<string, { bytes: Uint8Array; expiresAtMs: number }>();
  failNextGet = false;
  async put(exportId: string, bytes: Uint8Array, expiresAtMs: number) { this.map.set(exportId, { bytes, expiresAtMs }); }
  async get(exportId: string, nowMs: number) {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('buffer get down');
    }
    const v = this.map.get(exportId);
    return v && v.expiresAtMs > nowMs ? v.bytes : null;
  }
}

const store = new StoreFake();
const buffer = new BufferFake();
const silver = {
  calls: [] as Array<{ eventId: string; fromMs: number; toMs: number }>,
  nextError: null as Error | null,
  next: null as any,
  async build(i: { eventId: string; fromMs: number; toMs: number }) {
    this.calls.push({ ...i });
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }
    if (this.next) {
      const v = this.next;
      this.next = null;
      return v;
    }
    return { bytes: ARROW, rowCount: 7, columns: COLUMNS };
  },
};
const audit = {
  rows: [] as any[],
  failNext: false,
  async append(r: any) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('audit down');
    }
    this.rows.push(r);
  },
};
const log = {
  rows: [] as any[],
  failNext: false,
  async append(r: any) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('pseudonymization log down');
    }
    this.rows.push(r);
  },
};
const alerts: any[] = [];
const config = { allowlistVersion: 'v1', approvedReviewVersions: ['v1'] as string[], keyVersion: 'analytics-v1' };
const schedule = {
  failNext: false,
  async get(eventId: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('schedule down');
    }
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

const body = (o: Record<string, unknown> = {}) => ({ eventId: EVENT, fromMs: 0, toMs: HALF_HOUR, reason: '다음 회차 봇 판정 규칙 개선', ...o });
const post = (who: Record<string, string>, payload: unknown, idem = randomUUID()): Promise<Req> =>
  svc.http.inject({
    method: 'POST',
    url: '/v1/ops/research-exports',
    headers: { ...who, 'content-type': 'application/json', 'idempotency-key': idem },
    payload: JSON.stringify(payload),
  }) as unknown as Promise<Req>;
const get = (who: Record<string, string>, id: string, fetch: Record<string, string> = { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }): Promise<Req> =>
  svc.http.inject({ method: 'GET', url: `/v1/ops/research-exports/${id}`, headers: { ...who, ...fetch } }) as unknown as Promise<Req>;

/** 연구 모듈은 구현 전에는 없다. 계획대로 index.ts를 본다(구현은 .js 파일을 만들지 않는다). */
async function researchModule(): Promise<Record<string, any> | null> {
  const url = new URL('../src/modules/research-exports/index.ts', import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return (await import(/* @vite-ignore */ url.href)) as Record<string, any>;
}
const service = async () => {
  const mod = await researchModule();
  expect(mod, 'research-exports 모듈이 아직 없다').not.toBeNull();
  if (!mod) return null;
  return svc.app.get(mod.ResearchExports) as any;
};

const deniedAudit = () => audit.rows.filter((r) => r.payload?.outcome === 'DENIED');
const deniedLog = () => log.rows.filter((r) => r.usage?.outcome === 'DENIED');
const requestedAudit = () => audit.rows.filter((r) => r.payload?.outcome === 'REQUESTED');
const requestedLog = () => log.rows.filter((r) => r.usage?.outcome === 'REQUESTED');

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
  store.failNextGet = false;
  store.failNextPut = false;
  store.failNextUpdate = false;
  store.countDelayMs = 0;
  buffer.map.clear();
  buffer.failNextGet = false;
  silver.calls.length = 0;
  silver.nextError = null;
  silver.next = null;
  audit.rows.length = 0;
  audit.failNext = false;
  log.rows.length = 0;
  log.failNext = false;
  alerts.length = 0;
  schedule.failNext = false;
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
    expect(deniedAudit()).toHaveLength(3);
    expect(deniedLog()).toHaveLength(3);
    for (const row of deniedAudit()) {
      expect(row.payload).toMatchObject({ action: 'DENY', problemType: 'pseudonym-handler-required', rowCount: 0, outcome: 'DENIED', fromMs: 0, toMs: HALF_HOUR });
      expect(row.payload.role).toBe('commander');
      expect(row.payload.columns).toHaveLength(16);
      expect(row.payload.atMs).toBe(NOW);
      expect(row.recordId).toBeTruthy();
    }
    for (const row of deniedLog()) {
      expect(row.purpose).toBe('SCIENTIFIC_RESEARCH');
      expect(row.usage).toMatchObject({ outcome: 'DENIED', problemType: 'pseudonym-handler-required', rowCount: 0 });
    }
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
    expect(deniedAudit()).toHaveLength(2);
    expect(deniedLog()).toHaveLength(2);
    for (const row of deniedAudit()) expect(row.payload).toMatchObject({ action: 'DENY', problemType: 'pseudonymization-review-pending' });
    for (const row of deniedLog()) expect(row.usage).toMatchObject({ outcome: 'DENIED', problemType: 'pseudonymization-review-pending' });
  });

  test('FX-T10 ③ [ASVS v5.0.0-2.2.3] 시간창·사유·열 목록이 틀리면 422/400이고 성공 기록·감사 줄이 없다', async () => {
    const who = commander();
    const badWindows = [body({ toMs: HALF_HOUR + 1 }), body({ fromMs: -1 }), body({ fromMs: 5, toMs: 5 }), body({ fromMs: 9, toMs: 1 })];
    for (const b of badWindows) {
      const r = await post(who, b);
      expect(r.statusCode, r.payload).toBe(422);
      expect(problemType(r), r.payload).toBe('about:blank');
    }
    const badBodies = [
      { eventId: EVENT, fromMs: 0, toMs: HALF_HOUR },
      { ...body(), reason: '' },
      { ...body(), reason: 'x'.repeat(501) },
      { ...body(), reason: 123 },
      { ...body(), columns: ['t_ms'] },
      { ...body(), fields: ['t_ms'] },
    ];
    for (const b of badBodies) {
      const r = await post(who, b);
      expect(r.statusCode, r.payload).toBe(400);
      expect(problemType(r), r.payload).toBe('invalid-body');
    }
    expect(store.map.size).toBe(0);
    expect(deniedAudit()).toHaveLength(4);
    expect(deniedLog()).toHaveLength(4);
    for (const row of deniedAudit()) expect(row.payload.problemType).toBe('about:blank');
    for (const row of deniedLog()) expect(row.usage.problemType).toBe('about:blank');
    expect(requestedAudit()).toHaveLength(0);

    const ok = await post(who, body({ reason: 'x'.repeat(500) }));
    expect(ok.statusCode, ok.payload).toBe(202);
    expect(requestedAudit()).toHaveLength(1);
    expect(requestedLog()).toHaveLength(1);
    expect(store.map.size).toBe(1);
  });

  test('FX-T10 ④ [ASVS v5.0.0-2.2.3] 보존이 지난 회차는 422이고 내보내지 않는다', async () => {
    const who = commander();
    const r = await post(who, body({ eventId: OLD }));
    expect(r.statusCode, r.payload).toBe(422);
    expect(problemType(r), r.payload).toBe('about:blank');
    expect(store.map.size).toBe(0);
    expect(deniedAudit()).toHaveLength(1);
    expect(deniedLog()).toHaveLength(1);
    expect(deniedAudit()[0].payload.problemType).toBe('about:blank');
    expect(deniedLog()[0].usage.problemType).toBe('about:blank');
  });

  test('FX-T10 ⑤ [ASVS v5.0.0-2.4.1] UTC 하루 5회를 넘으면 429 Retry-After이고 여섯 번째는 만들지 않는다', async () => {
    const a = commander();
    for (let n = 0; n < 5; n += 1) {
      const r = await post(a, body());
      expect(r.statusCode, r.payload).toBe(202);
      expect(json(r).status).toBe('PENDING');
      expect(String(header(r, 'cache-control')).toLowerCase()).toContain('no-store');
    }
    const sixth = await post(a, body());
    expect(sixth.statusCode, sixth.payload).toBe(429);
    expect(problemType(sixth)).toBe('about:blank');
    expect(header(sixth, 'retry-after')).toBe('54000');
    expect(deniedAudit()).toHaveLength(1);
    expect(deniedLog()).toHaveLength(1);
    expect(deniedAudit()[0].payload.problemType).toBe('about:blank');
    expect(deniedLog()[0].usage.problemType).toBe('about:blank');

    // 다른 계정은 자기 5회를 따로 쓴다.
    const b = commander();
    for (let n = 0; n < 5; n += 1) expect((await post(b, body())).statusCode).toBe(202);
    expect((await post(b, body())).statusCode).toBe(429);

    // 거절(422)은 한도에 세지 않는다.
    const c = commander();
    for (let n = 0; n < 3; n += 1) expect((await post(c, body({ toMs: HALF_HOUR + 1 }))).statusCode).toBe(422);
    for (let n = 0; n < 5; n += 1) expect((await post(c, body())).statusCode).toBe(202);
    expect((await post(c, body())).statusCode).toBe(429);
    expect(store.map.size).toBe(15);

    clock.advance(DAY);
    const next = await post(a, body());
    expect(next.statusCode, next.payload).toBe(202);
    expect(store.map.size).toBe(16);
  });

  test('FX-T10 ⑥ [ASVS v5.0.0-16.2.1] [ASVS v5.0.0-14.2.4] 성공·받기·거절이 감사와 pseudonymization_log에 남고 STATISTICS와 섞이지 않는다', async () => {
    const who = commander();
    log.rows.push({ purpose: 'STATISTICS', usage: { outcome: 'LOADED' } });
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    expect(String(header(created, 'cache-control')).toLowerCase()).toContain('no-store');
    const id = String(json(created).exportId);
    expect(requestedAudit()).toHaveLength(1);
    expect(requestedAudit()[0]).toMatchObject({
      recordType: 'RESEARCH_EXPORT',
      recordId: id,
      payload: {
        action: 'CREATE',
        accountId: who['x-user-id'],
        role: 'commander',
        eventId: EVENT,
        fromMs: 0,
        toMs: HALF_HOUR,
        columns: COLUMNS,
        rowCount: 0,
        reason: '다음 회차 봇 판정 규칙 개선',
        outcome: 'REQUESTED',
        atMs: NOW,
      },
    });
    expect(requestedAudit()[0].payload.problemType).toBeUndefined();

    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    const got = await get(who, id);
    expect(got.statusCode, got.payload).toBe(200);

    const research = log.rows.filter((r) => r.purpose === 'SCIENTIFIC_RESEARCH');
    expect(research.map((r) => r.usage.outcome)).toEqual(['REQUESTED', 'READY', 'RECEIVED']);
    expect(log.rows.filter((r) => r.purpose === 'STATISTICS')).toHaveLength(1);
    expect(new Set(log.rows.map((r) => r.purpose))).toEqual(new Set(['STATISTICS', 'SCIENTIFIC_RESEARCH']));
    expect(audit.rows.map((r) => r.payload.outcome)).toEqual(['REQUESTED', 'RECEIVED']);
    expect(audit.rows[1].payload).toMatchObject({ action: 'RECEIVE', rowCount: 7, outcome: 'RECEIVED' });
    expect(audit.rows[1].recordId).toBe(id);
    expect(audit.rows[1].payload.columns).toHaveLength(16);

    // 이용 내역 append가 실패하면 레코드를 남기지 않고 503이다.
    const before = store.map.size;
    log.failNext = true;
    const logFail = await post(who, body());
    expect(logFail.statusCode, logFail.payload).toBe(503);
    expect(problemType(logFail)).toBe('dependency-unavailable');
    expect(store.map.size).toBe(before);
    expect(requestedAudit()).toHaveLength(1);

    // 감사 append가 실패해도 202로 보이지 않고 레코드를 남기지 않는다. 이용 내역 한 줄은 남을 수 있다.
    audit.failNext = true;
    const auditFail = await post(who, body());
    expect(auditFail.statusCode, auditFail.payload).toBe(503);
    expect(problemType(auditFail)).toBe('dependency-unavailable');
    expect(store.map.size).toBe(before);
    expect(requestedAudit()).toHaveLength(1);
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
    expect(deniedAudit()).toHaveLength(3);
    expect(deniedLog()).toHaveLength(3);
    for (const row of deniedAudit()) expect(row.payload.problemType).toBe('pseudonym-handler-required');
    for (const row of deniedLog()) expect(row.usage.problemType).toBe('pseudonym-handler-required');
    expect(store.map.get(id)?.status).toBe('READY');
  });

  test('FX-T10 ⑨ [ASVS v5.0.0-8.2.2] 만든 세션만 받고 준비 중이면 409 Retry-After이며 없는·만료된 내보내기는 404다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);

    const early = await get(who, id);
    expect(early.statusCode, early.payload).toBe(409);
    expect(problemType(early), early.payload).toBe('research-export-not-ready');
    expect(header(early, 'retry-after')).toBe('1800');

    const otherSession = randomUUID();
    identity.answers.set(`${who['x-user-id']}/${otherSession}`, { valid: true, role: 'commander' });
    const bySession = await get({ ...who, 'x-session-id': otherSession }, id);
    expect(bySession.statusCode, bySession.payload).toBe(403);
    const otherAccount = commander();
    const byAccount = await get(otherAccount, id);
    expect(byAccount.statusCode, byAccount.payload).toBe(403);
    expect(deniedAudit()).toHaveLength(2);
    expect(deniedLog()).toHaveLength(2);
    for (const row of deniedAudit()) expect(row.payload.problemType).toBe('pseudonym-handler-required');
    for (const row of deniedLog()) expect(row.usage.problemType).toBe('pseudonym-handler-required');

    const missing = await get(who, randomUUID());
    expect(missing.statusCode, missing.payload).toBe(404);

    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    for (let n = 0; n < 2; n += 1) {
      const ok = await get(who, id);
      expect(ok.statusCode, ok.payload).toBe(200);
      expect(Buffer.from(ok.rawPayload ?? [])).toEqual(Buffer.from(ARROW));
    }
    expect(audit.rows.filter((r) => r.payload?.outcome === 'RECEIVED')).toHaveLength(2);
    expect(log.rows.filter((r) => r.usage?.outcome === 'RECEIVED')).toHaveLength(2);

    clock.advance(HALF_HOUR + 1);
    const expired = await get(who, id);
    expect(expired.statusCode, expired.payload).toBe(404);
    expect(audit.rows.filter((r) => r.payload?.outcome === 'RECEIVED')).toHaveLength(2);
  });

  test('FX-T10 ⑩ 같은 Idempotency-Key는 같은 exportId·createdAt을 만들고 한도·감사·이용 내역을 두 번 세지 않는다', async () => {
    const who = commander();
    const key = randomUUID();
    const a = await post(who, body(), key);
    const b = await post(who, body(), key);
    expect(a.statusCode, a.payload).toBe(202);
    expect(b.statusCode, b.payload).toBe(202);
    expect(json(a).exportId).toBe(json(b).exportId);
    expect(json(a).createdAt).toBe(json(b).createdAt);
    expect(store.map.size).toBe(1);
    expect(requestedAudit()).toHaveLength(1);
    expect(requestedLog()).toHaveLength(1);

    const diff = await post(who, body({ reason: '다른 사유' }), key);
    expect(diff.statusCode, diff.payload).toBe(422);
    expect(problemType(diff)).toBe('idempotency-key-reused');
    expect(store.map.size).toBe(1);
    expect(requestedAudit()).toHaveLength(1);
  });

  test('A-T23 ① [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2] 지정 commander가 만들고 받는 흐름이 202→409→200이고 이용 내역이 남는다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    expect(json(created)).toMatchObject({ eventId: EVENT, status: 'PENDING' });
    expect(json(created).createdAt).toBeTruthy();
    expect((await get(who, id)).statusCode).toBe(409);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    const got = await get(who, id);
    expect(got.statusCode, got.payload).toBe(200);
    expect(Buffer.from(got.rawPayload ?? [])).toEqual(Buffer.from(ARROW));
    expect(log.rows.filter((r) => r.purpose === 'SCIENTIFIC_RESEARCH').map((r) => r.usage.outcome)).toEqual(['REQUESTED', 'READY', 'RECEIVED']);
    expect(audit.rows.map((r) => r.payload.action)).toEqual(['CREATE', 'RECEIVE']);

    // buildDue의 실패 경계: 실버 예외·봉투·열·행 수·200MB. 모두 FAILED·감사 BUILD_FAILED·이용 내역 FAILED·GET 404다.
    const failWho = commander();
    const failOnce = async (next: { error?: Error; value?: any }, failureType: string) => {
      const c = await post(failWho, body());
      expect(c.statusCode, c.payload).toBe(202);
      const failId = String(json(c).exportId);
      if (next.error) silver.nextError = next.error;
      else silver.next = next.value;
      await svcMod.buildDue(clock.now());
      expect(store.map.get(failId)?.status, failureType).toBe('FAILED');
      expect(store.map.get(failId)?.failureType, failureType).toBe(failureType);
      const a = audit.rows.find((r) => r.recordId === failId && r.payload?.outcome === 'FAILED');
      expect(a, failureType).toBeTruthy();
      expect(a!.payload).toMatchObject({
        action: 'BUILD_FAILED',
        outcome: 'FAILED',
        problemType: failureType,
        role: 'commander',
        fromMs: 0,
        toMs: HALF_HOUR,
        columns: COLUMNS,
        atMs: NOW,
      });
      expect(a!.payload.columns).toHaveLength(16);
      const l = log.rows.find((r) => r.usage?.exportId === failId && r.usage?.outcome === 'FAILED');
      expect(l, failureType).toBeTruthy();
      expect(l!.usage.problemType).toBe(failureType);
      const notFound = await get(failWho, failId);
      expect(notFound.statusCode, notFound.payload).toBe(404);
    };
    await failOnce({ error: new Error('clickhouse down') }, 'SILVER_ERROR');
    await failOnce({ value: { bytes: new TextEncoder().encode('NOPE'), rowCount: 1, columns: COLUMNS } }, 'INVALID_ENVELOPE');
    await failOnce({ value: { bytes: ARROW, rowCount: 1, columns: COLUMNS.slice(0, 15) } }, 'INVALID_COLUMNS');
    await failOnce({ value: { bytes: ARROW, rowCount: -1, columns: COLUMNS } }, 'INVALID_ROW_COUNT');
    const huge = new Uint8Array(200 * 1024 * 1024 + 1);
    huge.set(ARROW.subarray(0, 6), 0);
    huge.set(ARROW.subarray(-6), huge.length - 6);
    await failOnce({ value: { bytes: huge, rowCount: 1, columns: COLUMNS } }, 'TOO_LARGE');
  });

  test('FX-T17 ③ [ASVS v5.0.0-8.2.3] 실버에는 회차·시간창만 넘기고 조사 칸·원문 IP를 넘기지 않는다', async () => {
    const who = commander();
    const created = await post(who, body({ fromMs: 10, toMs: 20 }));
    expect(created.statusCode, created.payload).toBe(202);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());
    expect(silver.calls).toHaveLength(1);
    expect(Object.keys(silver.calls[0]).sort()).toEqual(['eventId', 'fromMs', 'toMs']);
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
    expect(deniedAudit()).toHaveLength(1);
    expect(deniedLog()).toHaveLength(1);
  });

  test('FX-T21 ⑥ [ASVS v5.0.0-2.3.1] 준비 중이면 409 research-export-not-ready와 Retry-After다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const early = await get(who, String(json(created).exportId));
    expect(early.statusCode, early.payload).toBe(409);
    expect(problemType(early), early.payload).toBe('research-export-not-ready');
    expect(header(early, 'retry-after')).toBe('1800');
  });

  test('FX-T10 ⑫ [ASVS v5.0.0-16.3.3] 같은 계정의 거절이 10분 안에 3번이면 보안 경보를 한 번 낸다(422·429 포함, 계정별)', async () => {
    const a = commander();
    config.approvedReviewVersions = [];
    for (let n = 0; n < 2; n += 1) expect((await post(a, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(0);
    expect((await post(a, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'RESEARCH_EXPORT_DENIALS', accountId: a['x-user-id'], count: 3 });
    expect((await post(a, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(1);
    clock.advance(600_001);
    expect((await post(a, body())).statusCode).toBe(403);
    expect(alerts).toHaveLength(1);

    // 422도 경보 대상이다. 검토 결과서는 승인된 판으로 되돌린다.
    config.approvedReviewVersions = ['v1'];
    const b = commander();
    for (let n = 0; n < 3; n += 1) expect((await post(b, body({ toMs: HALF_HOUR + 1 }))).statusCode).toBe(422);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({ accountId: b['x-user-id'], count: 3 });

    // 계정별로 센다: A 2번 + B 2번은 경보가 없고, B 3번째에 B만 경보한다.
    const c = commander();
    const d = commander();
    for (let n = 0; n < 2; n += 1) {
      expect((await post(c, body({ toMs: HALF_HOUR + 1 }))).statusCode).toBe(422);
      expect((await post(d, body({ toMs: HALF_HOUR + 1 }))).statusCode).toBe(422);
    }
    expect(alerts).toHaveLength(2);
    expect((await post(d, body({ toMs: HALF_HOUR + 1 }))).statusCode).toBe(422);
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toMatchObject({ accountId: d['x-user-id'], count: 3 });
    expect((await post(d, body({ toMs: HALF_HOUR + 1 }))).statusCode).toBe(422);
    expect(alerts).toHaveLength(3);

    // 429도 경보 대상이다. 5번 성공 뒤 3번 429면 3번째 429에서 한 번, 4번째에는 다시 올리지 않는다.
    const e = commander();
    for (let n = 0; n < 5; n += 1) expect((await post(e, body())).statusCode).toBe(202);
    for (let n = 0; n < 2; n += 1) expect((await post(e, body())).statusCode).toBe(429);
    expect(alerts).toHaveLength(3);
    expect((await post(e, body())).statusCode).toBe(429);
    expect(alerts).toHaveLength(4);
    expect(alerts[3]).toMatchObject({ accountId: e['x-user-id'], count: 3 });
    expect((await post(e, body())).statusCode).toBe(429);
    expect(alerts).toHaveLength(4);
    // 5·6번째 거절에서도 다시 경보하지 않는다(n % 3 === 0 틀린 구현을 잡는다).
    for (let n = 0; n < 2; n += 1) expect((await post(e, body())).statusCode).toBe(429);
    expect(alerts).toHaveLength(4);
  });

  test('IR0419-01 연구 내보내기 스윕은 tick마다 buildDue를 부르고 stop 뒤에는 부르지 않는다', async () => {
    const mod = await researchModule();
    expect(mod, 'research-exports 모듈이 아직 없다').not.toBeNull();
    if (!mod) return;
    expect(typeof mod.startResearchExportSweep).toBe('function');
    if (typeof mod.startResearchExportSweep !== 'function') return;
    let calls = 0;
    const sweep = mod.startResearchExportSweep({
      buildDue: async () => { calls += 1; return 0; },
      now: () => NOW,
      intervalMs: 1_000_000,
    });
    await sweep.tick();
    expect(calls).toBe(1);
    await sweep.tick();
    expect(calls).toBe(2);
    sweep.stop();
    await sweep.tick();
    expect(calls).toBe(2);
  });

  test('IR0419-01 스윕의 buildDue는 만료된 레코드를 지운다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    const svcMod = await service();
    if (!svcMod) return;
    clock.advance(HALF_HOUR + 1);
    await svcMod.buildDue(clock.now());
    expect(store.map.has(id)).toBe(false);
  });

  test('IR0419-04 만료된 PENDING은 409가 아니라 404다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    clock.advance(HALF_HOUR + 1);
    const expired = await get(who, id);
    expect(expired.statusCode, expired.payload).toBe(404);
    expect(problemType(expired)).not.toBe('research-export-not-ready');
  });

  test('IR0419-05 받기의 이용 내역·감사 append 실패는 503이고 파일은 남는다', async () => {
    const who = commander();
    const created = await post(who, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());

    log.failNext = true;
    const logFail = await get(who, id);
    expect(logFail.statusCode, logFail.payload).toBe(503);
    expect(problemType(logFail)).toBe('dependency-unavailable');
    expect((await get(who, id)).statusCode).toBe(200);

    audit.failNext = true;
    const auditFail = await get(who, id);
    expect(auditFail.statusCode, auditFail.payload).toBe(503);
    expect(problemType(auditFail)).toBe('dependency-unavailable');
    expect((await get(who, id)).statusCode).toBe(200);
  });

  test('IR0419-05 buildDue의 저장·감사·이용 내역 실패는 레코드를 PENDING으로 남긴다', async () => {
    const who = commander();
    const svcMod = await service();
    if (!svcMod) return;
    const create = async () => {
      store.map.clear();
      buffer.map.clear();
      const r = await post(who, body());
      expect(r.statusCode, r.payload).toBe(202);
      return String(json(r).exportId);
    };

    const failedLog = await create();
    silver.nextError = new Error('clickhouse down');
    log.failNext = true;
    await svcMod.buildDue(clock.now());
    expect(store.map.get(failedLog)?.status).toBe('PENDING');
    expect(store.map.get(failedLog)?.failureType).toBeNull();
    silver.nextError = null;
    log.failNext = false;

    const failedAudit = await create();
    silver.nextError = new Error('clickhouse down');
    audit.failNext = true;
    await svcMod.buildDue(clock.now());
    expect(store.map.get(failedAudit)?.status).toBe('PENDING');
    silver.nextError = null;
    audit.failNext = false;

    const readyLog = await create();
    log.failNext = true;
    await svcMod.buildDue(clock.now());
    expect(store.map.get(readyLog)?.status).toBe('PENDING');
    log.failNext = false;
    await svcMod.buildDue(clock.now());
    expect(store.map.get(readyLog)?.status).toBe('READY');

    const readyUpdate = await create();
    store.failNextUpdate = true;
    await svcMod.buildDue(clock.now());
    expect(store.map.get(readyUpdate)?.status).toBe('PENDING');
    await svcMod.buildDue(clock.now());
    expect(store.map.get(readyUpdate)?.status).toBe('READY');
  });

  test('IR0419-06 LoggingResearchAlerts 기본 대역은 SEV3 경보를 JSON 줄로 남긴다', async () => {
    const mod = await researchModule();
    expect(mod, 'research-exports 모듈이 아직 없다').not.toBeNull();
    if (!mod) return;
    expect(typeof mod.LoggingResearchAlerts).toBe('function');
    if (typeof mod.LoggingResearchAlerts !== 'function') return;
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await new mod.LoggingResearchAlerts().raise({ kind: 'RESEARCH_EXPORT_DENIALS', accountId: 'acct-1', count: 3, atMs: NOW, severity: 'SEV3' });
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }
    const line = chunks.join('');
    expect(line).toContain('research_export_alert');
    expect(line).toContain('SEV3');
    expect(line).toContain('acct-1');
  });

  test('IR0419-07 같은 계정 동시 POST는 5회를 넘지 않고 같은 키 동시 요청은 한 번만 만든다', async () => {
    const who = commander();
    store.countDelayMs = 10;
    for (let n = 0; n < 4; n += 1) expect((await post(who, body())).statusCode).toBe(202);
    const [a, b] = await Promise.all([post(who, body()), post(who, body())]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 429]);
    expect([...store.map.values()].filter((r) => r.createdBy === who['x-user-id'])).toHaveLength(5);

    const who2 = commander();
    const key = randomUUID();
    const before = requestedAudit().length;
    const [c, d] = await Promise.all([post(who2, body(), key), post(who2, body(), key)]);
    expect([c.statusCode, d.statusCode]).toEqual([202, 202]);
    expect([...store.map.values()].filter((r) => r.createdBy === who2['x-user-id'])).toHaveLength(1);
    expect(requestedAudit().length).toBe(before + 1);
  });

  test('IR0419-08 schedule·store·buffer 의존 실패는 503이다', async () => {
    const who = commander();
    schedule.failNext = true;
    const scheduleFail = await post(who, body());
    expect(scheduleFail.statusCode, scheduleFail.payload).toBe(503);
    expect(problemType(scheduleFail)).toBe('dependency-unavailable');
    expect(store.map.size).toBe(0);

    const who2 = commander();
    const created = await post(who2, body());
    expect(created.statusCode, created.payload).toBe(202);
    const id = String(json(created).exportId);
    const svcMod = await service();
    if (!svcMod) return;
    await svcMod.buildDue(clock.now());

    store.failNextGet = true;
    const storeFail = await get(who2, id);
    expect(storeFail.statusCode, storeFail.payload).toBe(503);
    expect(problemType(storeFail)).toBe('dependency-unavailable');
    expect((await get(who2, id)).statusCode).toBe(200);

    buffer.failNextGet = true;
    const bufferFail = await get(who2, id);
    expect(bufferFail.statusCode, bufferFail.payload).toBe(503);
    expect(problemType(bufferFail)).toBe('dependency-unavailable');
    expect((await get(who2, id)).statusCode).toBe(200);

    const who3 = commander();
    store.failNextPut = true;
    const putFail = await post(who3, body());
    expect(putFail.statusCode, putFail.payload).toBe(503);
    expect(problemType(putFail)).toBe('dependency-unavailable');
    expect([...store.map.values()].filter((r) => r.createdBy === who3['x-user-id'])).toHaveLength(0);
  });
});
