// 운영 명령 수명주기 HTTP 경계 시험(BAT-355 OPS-260, docs/features/control-tower.md §3·§4, ADR-0339·0340, authz-matrix §6).
// 접수 검사·안전 한계(C-T3), 2인 승인 기한·분리(C-T4·AZ-T10), 위험 명령 재인증(C-T5·I-T53 ⑤), 명령 4의 2인 조건(ADR-0339),
// 사건 차례·단계 건너뛰기(2.3.1), 행위자·상태 칸 거절과 SYSTEM 자동 조치(8.2.3), 내부 사건 길의 서버 판정(8.3.1), 멱등, 되돌리기·연장·자동 만료,
// 사람 칸의 가명 참조와 3년 지우기(16.2.1)를 바깥 HTTP와 모듈 공개 함수로 본다.
// 단언 값은 정본에서 온다: 목표 8,000·1,000, 승인 기한 10분, 명령 4 만료 24시간·항목 100개, /16·/48, 명령 2 10분·명령 8 30분, 대응 3년, 빈 UUID.
// 시계는 가짜 시계(fakeClock)이고, 재인증은 제품 JwksApprovalVerifier를 시험 키·jti 대역에 물린다(admin-support.ts).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  COMMAND_STORE,
  ComputeDryRun,
  MaintainCommands,
  MemoryCommandStore,
  commandIdOfEventKey,
  type Command,
  type CommandExecutionResult,
  type CommandExecutor,
  type CommandSendResult,
  type ProtectedRangeList,
} from '../src/modules/commands/index.js';
import { reauthKit, type ReauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

/** 시각은 초 경계에 둔다(재인증 토큰 exp는 초 단위) */
const NOW = Date.parse('2026-11-22T03:00:00.000Z');
/** 시스템 행위자: 모든 자리가 0인 빈 UUID(ADR-0340 결정 8) */
const SYSTEM_REF = '00000000-0000-0000-0000-000000000000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 시험용 보호 목록(ADR-0339 결정 4: 첫 판의 CIDR은 비어 있어 시험은 시험용 목록을 넣는다). TEST-NET-3 대역 */
const TEST_RANGES: ProtectedRangeList = {
  version: 'test-2026-11-22',
  ranges: [{ kind: 'CIDR', value: '203.0.113.0/24', category: 'KR_CARRIER', label: '시험 통신사', source: 'BAT-355 시험' }],
};

type Headers = Record<string, string>;
/** 응답에서 시험이 읽는 칸(light-my-request 응답의 부분) */
type Res = { readonly statusCode: number; readonly payload: string };

interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly kit: ReauthKit;
  readonly audit: MemoryAuditChain;
  readonly store: MemoryCommandStore;
  readonly maintain: MaintainCommands;
  readonly calls: { readonly execute: string[]; readonly revert: string[]; readonly extend: string[] };
  /** 실행 포트를 부른 그때의 사건·감사 차례(감사가 DISPATCHED 앞에 커밋됐는지 본다) */
  readonly seenAtExecute: Map<string, { events: string[]; audits: string[] }>;
  sendResult: CommandSendResult;
  post(url: string, who: Headers, body: unknown, extra?: Headers): Promise<Res>;
  get(url: string, who: Headers): Promise<Res>;
  token(who: Headers, o?: { factors?: readonly string[]; sessionId?: string; accountId?: string; jti?: string }): string;
  withToken(who: Headers, o?: { factors?: readonly string[]; sessionId?: string; accountId?: string; jti?: string }): Headers;
}

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
  vi.unstubAllEnvs();
});

/** 시험마다 새 서비스(메모리 조립). 실행 포트는 받은 명령 ID만 적고 ACKED를 준다(카탈로그 명령의 성공은 ACKED, ADR-0340 결정 1) */
async function harness(o: { protectedRanges?: ProtectedRangeList; result?: (c: Command) => CommandExecutionResult } = {}): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const kit = reauthKit(() => clock.now());
  const audit = new MemoryAuditChain();
  const calls = { execute: [] as string[], revert: [] as string[], extend: [] as string[] };
  const seenAtExecute = new Map<string, { events: string[]; audits: string[] }>();
  let store: MemoryCommandStore | undefined;
  const h = { sendResult: { status: 'ACKED' } as CommandSendResult } as { sendResult: CommandSendResult };
  const executor: CommandExecutor = {
    execute: async (c) => {
      calls.execute.push(c.commandId);
      seenAtExecute.set(c.commandId, { events: (store?.eventsOf(c.commandId) ?? []).map((e) => e.type), audits: audit.entries.filter((e) => e.recordId === c.commandId).map((e) => e.recordType) });
      return o.result?.(c) ?? { status: 'ACKED', ackedAtMs: clock.now() };
    },
    revert: async (c) => (calls.revert.push(c.commandId), h.sendResult),
    extend: async (c) => (calls.extend.push(c.commandId), h.sendResult),
  };
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      executor,
      auditChain: audit,
      adminAccounts: { identity: new UnavailableAdminIdentity(), reauth: kit.verifier },
      ...(o.protectedRanges ? { commandExtras: { protectedRanges: o.protectedRanges } } : {}),
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const found: unknown = svc.app.get(COMMAND_STORE);
  if (!(found instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
  store = found;
  const token = (who: Headers, t: { factors?: readonly string[]; sessionId?: string; accountId?: string; jti?: string } = {}) =>
    kit.token({ accountId: t.accountId ?? who['x-user-id']!, sessionId: t.sessionId ?? who['x-session-id']!, act: 'OPS_COMMAND', ...(t.factors ? { factors: t.factors } : {}), ...(t.jti ? { jti: t.jti } : {}) });
  const harnessed: Harness = Object.assign(h, {
    svc,
    clock,
    identity,
    kit,
    audit,
    store,
    maintain: svc.app.get(MaintainCommands),
    calls,
    seenAtExecute,
    // 접수(POST /v1/ops/commands)는 Idempotency-Key가 필요하다(ADR-0340 결정 7). extra로 키를 바꿔 넣을 수 있다
    post: (url: string, who: Headers, body: unknown, extra: Headers = {}) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, ...extra, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url: string, who: Headers) => svc.http.inject({ method: 'GET', url, headers: who }),
    token,
    withToken: (who: Headers, t: Parameters<typeof token>[1] = {}) => ({ ...who, 'x-reauth-token': token(who, t) }),
  });
  opened.push(harnessed);
  return harnessed;
}

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '');
const idOf = (r: { payload: string }) => json(r).commandId as string;
const iso = (ms: number) => new Date(ms).toISOString();
const block = (h: Harness, p: Record<string, unknown>) => ({ type: 'BLOCK_ASN_IP', reason: '대역 차단', params: { ...p, expiresAt: iso(h.clock.now() + HOUR) } });
const target = (eventId: string, value: number) => ({ type: 'ADMISSION_TARGET', reason: '목표 조정', params: { eventId, target: value } });

describe('C-T3 안전 한계(저장 전 422, 반영 0건)', () => {
  test('C-T3 [ASVS v5.0.0-2.3.2] 동시 입장 목표 8,001·999는 422 command-out-of-range이고 명령·사건·감사·멱등 기록·실행이 0건이며 7,999·8,000·1,000은 받는다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    const keys: string[] = [];
    for (const value of [8_001, 999]) {
      const key = randomUUID();
      keys.push(key);
      const r = await h.post('/v1/ops/commands', op, target(eventId, value), { 'idempotency-key': key });
      expect(r.statusCode, String(value)).toBe(422);
      expect(slug(r), String(value)).toMatch(/command-out-of-range$/);
      expect(String(json(r).detail ?? '')).not.toBe('');
      // 미리보기도 같은 함수로 거른다(ADR-0340 결정 9)
      const preview = await h.post('/v1/ops/command-dry-runs', op, target(eventId, value));
      expect(preview.statusCode, String(value)).toBe(422);
      expect(slug(preview)).toMatch(/command-out-of-range$/);
    }
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    expect(h.audit.entries).toEqual([]);
    expect(h.calls.execute).toEqual([]);
    // 막힌 요청은 멱등 기록이 없다: 같은 키로 한도 안의 본문을 보내면 처음 요청처럼 받는다(같은 키·다른 본문 422가 아니다)
    const again = await h.post('/v1/ops/commands', op, target(eventId, 7_999), { 'idempotency-key': keys[0]! });
    expect(again.statusCode, again.payload).toBe(201);
    for (const value of [8_000, 1_000]) {
      const r = await h.post('/v1/ops/commands', op, target(eventId, value));
      expect(r.statusCode, `${value} ${r.payload}`).toBe(201);
      expect(json(r)).toMatchObject({ type: 'ADMISSION_TARGET', state: 'ACKED', params: { eventId, target: value } });
    }
    expect(h.calls.execute).toHaveLength(3);
    expect(h.audit.entries.filter((e) => e.recordType === 'COMMAND_CREATED')).toHaveLength(3);
  });
});

describe('C-T4 2인 승인 기한(10분)과 요청자 분리', () => {
  test('C-T4 요청자 본인 승인은 403 command-requester-cannot-approve이고 승인 기록이 0건이며 다른 commander가 승인한다', async () => {
    const h = await harness();
    const requester = h.identity.ops('commander');
    const created = await h.post('/v1/ops/commands', h.withToken(requester), { type: 'BOT_LEVEL', reason: '봇 급증', params: { level: 'AGGRESSIVE' } });
    expect(json(created)).toMatchObject({ state: 'PENDING_APPROVAL', approvalExpiresAt: iso(NOW + 10 * MIN), approvals: [] });
    const id = idOf(created);
    const self = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(requester), {});
    expect(self.statusCode).toBe(403);
    expect(slug(self)).toMatch(/command-requester-cannot-approve$/);
    expect(json(await h.get(`/v1/ops/commands/${id}`, requester))).toMatchObject({ state: 'PENDING_APPROVAL', approvals: [], canApprove: false });
    expect(h.store.actors().filter((a) => a.commandId === id && a.side === 'APPROVER')).toEqual([]);
    expect(h.calls.execute).toEqual([]);
    const approver = h.identity.ops('commander');
    const ok = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {});
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok)).toMatchObject({ state: 'ACKED', approvals: [approver['x-user-id']] });
    expect(h.calls.execute).toEqual([id]);
  });

  test('C-T4 [ASVS v5.0.0-2.3.2] 승인 기한 10분 − 1ms의 승인은 통과하고, 10분 정각의 승인·거부는 409 command-not-pending이며 명령은 REJECTED(SYSTEM, approval-expired)로 닫힌다', async () => {
    const h = await harness();
    const requester = h.identity.ops('commander');
    const make = async (reason: string) => idOf(await h.post('/v1/ops/commands', h.withToken(requester), { type: 'DEGRADED_MODE', reason, params: { mode: 'PAYMENT' } }));
    const early = await make('기한 직전');
    const late = await make('기한 정각 승인');
    const lateReject = await make('기한 정각 거부');
    const approver = h.identity.ops('commander');
    h.clock.advance(10 * MIN - 1);
    const ok = await h.post(`/v1/ops/commands/${early}/approvals`, h.withToken(approver), {});
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok)).toMatchObject({ state: 'ACKED', approvals: [approver['x-user-id']] });
    h.clock.advance(1);
    const tooLate = await h.post(`/v1/ops/commands/${late}/approvals`, h.withToken(approver), {});
    expect(tooLate.statusCode).toBe(409);
    expect(slug(tooLate)).toMatch(/command-not-pending$/);
    const rejected = await h.post(`/v1/ops/commands/${lateReject}/rejections`, approver, { reason: '늦은 거부' });
    expect(rejected.statusCode).toBe(409);
    expect(slug(rejected)).toMatch(/command-not-pending$/);
    for (const id of [late, lateReject]) {
      expect(json(await h.get(`/v1/ops/commands/${id}`, approver))).toMatchObject({ state: 'REJECTED', approvals: [], canApprove: false });
      expect(h.store.eventsOf(id).at(-1)).toMatchObject({ type: 'REJECTED', actorRef: SYSTEM_REF, actorRole: 'system', reason: 'approval-expired' });
      expect(h.audit.entries.filter((e) => e.recordId === id).at(-1)?.record.payload).toEqual({ decision: 'REJECTED', approverRef: SYSTEM_REF, approverRole: 'system', reason: 'approval-expired' });
      expect(h.store.actors().filter((a) => a.commandId === id && a.side === 'APPROVER')).toEqual([]);
    }
    expect(h.calls.execute).toEqual([early]);
  });

  test('C-T4 정비 작업은 승인 기한 − 1ms에는 닫지 않고 10분 정각에 REJECTED(SYSTEM)로 닫는다', async () => {
    const h = await harness();
    const requester = h.identity.ops('commander');
    const id = idOf(await h.post('/v1/ops/commands', h.withToken(requester), { type: 'BOT_LEVEL', reason: '정비 기한', params: { level: 'RELAXED' } }));
    expect(await h.maintain.runOnce(NOW + 10 * MIN - 1)).toEqual({ approvalsExpired: 0, revertsExpired: 0, autoExpired: 0, compared: 0, actorsPurged: 0 });
    expect((await h.store.find(id))?.state).toBe('PENDING_APPROVAL');
    expect(await h.maintain.runOnce(NOW + 10 * MIN)).toMatchObject({ approvalsExpired: 1 });
    expect(await h.store.find(id)).toMatchObject({ state: 'REJECTED', approvals: [] });
    expect(h.store.eventsOf(id).map((e) => [e.type, e.actorRef, e.reason])).toEqual([
      ['CREATED', expect.stringMatching(UUID_V4), '정비 기한'],
      ['DRY_RUN', expect.stringMatching(UUID_V4), '정비 기한'],
      ['PENDING_APPROVAL', expect.stringMatching(UUID_V4), '정비 기한'],
      ['REJECTED', SYSTEM_REF, 'approval-expired'],
    ]);
  });
});

describe('AZ-T10 2인 승인 분리', () => {
  test('AZ-T10 요청자 본인 403·같은 사람 두 번 409(동시 포함)·낮은 역할 403이고 실패 쪽 승인 기록은 0명이다', async () => {
    const h = await harness();
    const requester = h.identity.ops('commander');
    const id = idOf(await h.post('/v1/ops/commands', h.withToken(requester), { type: 'BOT_LEVEL', reason: '분리 시험', params: { level: 'STANDARD' } }));
    const self = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(requester), {});
    expect([self.statusCode, slug(self)]).toEqual([403, expect.stringMatching(/command-requester-cannot-approve$/)]);
    // 명령 5는 commander만 승인한다(control-tower §3): operator는 403
    const operator = h.identity.ops('operator');
    const low = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(operator), {});
    expect([low.statusCode, slug(low)]).toEqual([403, expect.stringMatching(/command-role-forbidden$/)]);
    expect(h.store.actors().filter((a) => a.commandId === id && a.side === 'APPROVER')).toEqual([]);
    // 같은 사람이 동시에 두 번: 하나만 200, 다른 하나는 409
    const approver = h.identity.ops('commander');
    const both = await Promise.all([h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {}), h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {})]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const again = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {});
    expect(again.statusCode).toBe(409);
    expect(json(await h.get(`/v1/ops/commands/${id}`, approver))).toMatchObject({ approvals: [approver['x-user-id']] });
    expect(h.store.actors().filter((a) => a.commandId === id && a.side === 'APPROVER').map((a) => a.adminAccountId)).toEqual([approver['x-user-id']]);
    expect(h.calls.execute).toEqual([id]);
  });

  test('AZ-T10 명령 3 되돌리기 요청도 요청자 본인은 승인하지 못하고(403) 다른 operator 이상 한 명이 승인한다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const id = idOf(await h.post('/v1/ops/commands', h.withToken(commander), { type: 'KILL_SWITCH', reason: '긴급 정지', params: { scope: 'PLATFORM' } }));
    expect((await h.store.find(id))?.state).toBe('ACKED');
    const revert = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(commander), { reason: '판매 재개' });
    expect([revert.statusCode, json(revert).state]).toEqual([202, 'REVERT_PENDING']);
    const self = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(commander), {});
    expect([self.statusCode, slug(self)]).toEqual([403, expect.stringMatching(/command-requester-cannot-approve$/)]);
    expect(h.calls.revert).toEqual([]);
    const operator = h.identity.ops('operator');
    const ok = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(operator), {});
    expect([ok.statusCode, json(ok).state]).toEqual([200, 'REVERTED']);
    expect(h.calls.revert).toEqual([id]);
    // 회차 1의 요청자·승인자가 대응 표에 따로 있다(ADR-0340 결정 8)
    expect(h.store.actors().filter((a) => a.commandId === id && a.round === 1).map((a) => [a.side, a.adminAccountId])).toEqual([
      ['REQUESTER', commander['x-user-id']],
      ['APPROVER', operator['x-user-id']],
    ]);
  });
});

describe('C-T5 위험 명령 재인증', () => {
  test('C-T5 재인증 토큰이 없거나 틀린(패스키 없음·다른 세션·다른 계정·5분 지남·다시 쓴 jti) 접수는 403 reauth-required이고 명령·감사·실행이 0건이며, 판매 중지·재개도 접수에 재인증이 필요하다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const other = h.identity.ops('commander');
    const body = { type: 'KILL_SWITCH', reason: '긴급 정지', params: { scope: 'PLATFORM' } };
    const stale = h.token(commander);
    h.clock.advance(5 * MIN + 1);
    const cases: Array<[string, Headers]> = [
      ['토큰 없음', commander],
      ['패스키 없음', h.withToken(commander, { factors: ['password', 'totp'] })],
      ['다른 세션', h.withToken(commander, { sessionId: other['x-session-id']! })],
      ['다른 계정의 토큰', h.withToken(commander, { accountId: other['x-user-id']! })],
      ['5분 지난 토큰', { ...commander, 'x-reauth-token': stale }],
    ];
    for (const [label, headers] of cases) {
      const r = await h.post('/v1/ops/commands', headers, body);
      expect(r.statusCode, label).toBe(403);
      expect(slug(r), label).toMatch(/reauth-required$/);
    }
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    expect(h.audit.entries).toEqual([]);
    expect(h.calls.execute).toEqual([]);
    const once = h.token(commander, { jti: 'jti-c-t5-once' });
    const ok = await h.post('/v1/ops/commands', { ...commander, 'x-reauth-token': once }, body);
    expect(ok.statusCode, ok.payload).toBe(201);
    const replay = await h.post('/v1/ops/commands', { ...commander, 'x-reauth-token': once }, { ...body, reason: '두 번째' });
    expect([replay.statusCode, slug(replay)]).toEqual([403, expect.stringMatching(/reauth-required$/)]);
    expect((await h.store.list({ limit: 100 })).items.map((c) => c.commandId)).toEqual([idOf(ok)]);
    expect(h.calls.execute).toEqual([idOf(ok)]);
    // 판매 중지·재개(2인 승인)도 접수에 재인증이 필요하다(POL-038 ⑩, ADR-0123 결정 2).
    const seller = h.identity.ops('operator');
    for (const type of ['SALE_STOP', 'SALE_RESUME'] as const) {
      const saleBody = { type, reason: '판매 상태 변경', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } };
      const before = (await h.store.list({ limit: 100 })).items.length;
      const blocked = await h.post('/v1/ops/commands', seller, saleBody);
      expect([blocked.statusCode, slug(blocked)], type).toEqual([403, expect.stringMatching(/reauth-required$/)]);
      expect((await h.store.list({ limit: 100 })).items, type).toHaveLength(before);
      const saleOk = await h.post('/v1/ops/commands', h.withToken(seller), saleBody);
      expect([saleOk.statusCode, json(saleOk).state], type).toEqual([201, 'PENDING_APPROVAL']);
      expect(json(saleOk), type).toMatchObject({ requestedBy: { adminAccountId: seller['x-user-id'], role: 'operator' } });
    }
  });

  test('C-T5 [ASVS v5.0.0-2.2.1] 명령 4는 2인 조건(/15)일 때만 재인증을 요구하고, 1인 조건(/16)은 재인증 없이 접수해 바로 실행한다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const wide = await h.post('/v1/ops/commands', op, block(h, { cidrs: ['10.20.0.0/15'] }));
    expect([wide.statusCode, slug(wide)]).toEqual([403, expect.stringMatching(/reauth-required$/)]);
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    const narrow = await h.post('/v1/ops/commands', op, block(h, { cidrs: ['10.20.0.0/16'] }));
    expect(narrow.statusCode, narrow.payload).toBe(201);
    expect(json(narrow).state).toBe('ACKED');
    // 1인 명령은 승인 기한이 없다(2인만 10분)
    expect(json(narrow)).not.toHaveProperty('approvalExpiresAt');
    const wideOk = await h.post('/v1/ops/commands', h.withToken(op), block(h, { cidrs: ['10.20.0.0/15'] }));
    expect([wideOk.statusCode, json(wideOk).state]).toEqual([201, 'PENDING_APPROVAL']);
    expect(h.calls.execute).toEqual([idOf(narrow)]);
  });
});

describe('I-T53 ⑤ 되돌리기 요청의 재인증', () => {
  test('I-T53 ⑤ 패스키 없는 판매 재개(명령 3)·자동 제어 재개(명령 11) 요청은 403 reauth-required이고 REVERT_PENDING이 되지 않으며, 그 승인도 패스키를 요구한다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    for (const [type, params] of [
      ['KILL_SWITCH', { scope: 'PLATFORM' }],
      ['AUTOMATION_STOP', {}],
    ] as const) {
      const id = idOf(await h.post('/v1/ops/commands', h.withToken(commander), { type, reason: '멈춤', params }));
      expect((await h.store.find(id))?.state, type).toBe('ACKED');
      for (const [label, headers] of [
        ['토큰 없음', commander],
        ['패스키 없음', h.withToken(commander, { factors: ['password', 'totp'] })],
      ] as const) {
        const r = await h.post(`/v1/ops/commands/${id}/reversions`, headers, { reason: '재개' });
        expect(r.statusCode, `${type} ${label}`).toBe(403);
        expect(slug(r)).toMatch(/reauth-required$/);
      }
      expect(await h.store.find(id)).toMatchObject({ state: 'ACKED', round: 0 });
      expect(h.store.eventsOf(id).map((e) => e.type)).not.toContain('REVERT_REQUESTED');
      const pending = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(commander), { reason: '재개' });
      expect([pending.statusCode, json(pending).state, json(pending).approvalExpiresAt]).toEqual([202, 'REVERT_PENDING', iso(h.clock.now() + 10 * MIN)]);
      const operator = h.identity.ops('operator');
      const noPasskey = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(operator, { factors: ['password', 'totp'] }), {});
      expect([noPasskey.statusCode, slug(noPasskey)]).toEqual([403, expect.stringMatching(/reauth-required$/)]);
      expect(h.calls.revert).not.toContain(id);
      const ok = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(operator), {});
      expect([ok.statusCode, json(ok).state]).toEqual([200, 'REVERTED']);
    }
    expect(h.calls.revert).toHaveLength(2);
  });
});

describe('명령 4의 2인 조건과 입력(ADR-0339)', () => {
  test('[ASVS v5.0.0-2.3.5] 넓은 대역(IPv4 /15·IPv6 /47·::ffff: /111)·ASN·보호 대역(품거나 품김) 차단은 요청자 아닌 사람의 승인 뒤에만 실행된다(실행 포트 0 → 1)', async () => {
    const h = await harness({ protectedRanges: TEST_RANGES });
    const op = h.identity.ops('operator');
    const approver = h.identity.ops('operator');
    for (const p of [
      { cidrs: ['10.20.0.0/15'] },
      { cidrs: ['2001:db8::/47'] },
      { cidrs: ['::ffff:10.20.0.0/111'] },
      { asns: [64500] },
      { cidrs: ['203.0.113.64/26'] },
      { cidrs: ['203.0.112.0/22'] },
      { cidrs: ['198.51.100.0/24', '10.20.0.0/15'] },
    ]) {
      const label = JSON.stringify(p);
      const created = await h.post('/v1/ops/commands', h.withToken(op), block(h, p));
      expect([created.statusCode, json(created).state], label).toEqual([201, 'PENDING_APPROVAL']);
      const id = idOf(created);
      expect(h.calls.execute, label).not.toContain(id);
      const ok = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {});
      expect([ok.statusCode, json(ok).state], label).toEqual([200, 'ACKED']);
      expect(h.calls.execute.filter((x) => x === id), label).toEqual([id]);
    }
  });

  test('[ASVS v5.0.0-2.2.1] 명령 4의 1인 조건(IPv4 /16·IPv6 /48·::ffff: /112·보호 목록 밖)은 재인증 없이 접수해 바로 실행한다', async () => {
    const h = await harness({ protectedRanges: TEST_RANGES });
    const op = h.identity.ops('operator');
    for (const p of [{ cidrs: ['10.20.0.0/16'] }, { cidrs: ['2001:db8::/48'] }, { cidrs: ['::ffff:10.20.0.0/112'] }, { cidrs: ['198.51.100.0/24', '203.0.114.0/24'] }]) {
      const r = await h.post('/v1/ops/commands', op, block(h, p));
      expect([r.statusCode, json(r).state], JSON.stringify(p)).toEqual([201, 'ACKED']);
      expect(h.calls.execute).toContain(idOf(r));
    }
  });

  test('[ASVS v5.0.0-2.2.1] 명령 유형·봇 강도·재평가 모드·킬스위치 범위·대역·ASN은 허용 목록으로 거르고 목록 밖 값마다 거절하며 명령이 생기지 않는다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    // 명령 유형은 계약의 열거값이다(본문 검사 400)
    for (const type of ['NOPE', 'kill_switch', 'SYSTEM_ACTION']) {
      const r = await h.post('/v1/ops/commands', commander, { type, reason: '모르는 유형', params: {} });
      expect(r.statusCode, type).toBe(400);
      expect(slug(r), type).not.toMatch(/idempotency-key-invalid$/);
    }
    const invalid: Array<[string, Record<string, unknown>]> = [
      ...['DEBUG', 'relaxed', 'MAXIMUM', '', 2].map((level): [string, Record<string, unknown>] => ['BOT_LEVEL', { level }]),
      ...['AUTO', 'shadow', 'ON'].map((reassessMode): [string, Record<string, unknown>] => ['BOT_LEVEL', { level: 'STANDARD', reassessMode }]),
      ['BOT_LEVEL', { level: 'STANDARD', weight: 3 }],
      ...['GLOBAL', 'event', undefined].map((scope): [string, Record<string, unknown>] => ['KILL_SWITCH', scope === undefined ? {} : { scope, eventIds: [randomUUID()] }]),
      ['KILL_SWITCH', { scope: 'EVENT', eventIds: [] }],
      ['KILL_SWITCH', { scope: 'EVENT', eventIds: ['not-a-uuid'] }],
      ['KILL_SWITCH', { scope: 'EVENT', eventIds: ['0194b355-0000-7000-8000-000000000001', '0194B355-0000-7000-8000-000000000001'] }],
      ['KILL_SWITCH', { scope: 'PLATFORM', eventIds: [randomUUID()] }],
      ...['10.0.0.1/8', '0.0.0.0/0', '10.0.0.0', '10.0.0.0/33', '2001:db8::1/32', '::/0', 'abc/24', '10.0.0.0/8/8', '10.0.0.0/08x'].map((c): [string, Record<string, unknown>] => ['BLOCK_ASN_IP', { cidrs: [c] }]),
      ['BLOCK_ASN_IP', { cidrs: [] }],
      ['BLOCK_ASN_IP', { cidrs: [], asns: [] }],
      ['BLOCK_ASN_IP', { cidrs: ['10.0.0.0/8', '10.0.0.0/8'] }],
      ['BLOCK_ASN_IP', { asns: [64500, 64500] }],
      ...[0, 4_294_967_296, -1, 1.5, '64500'].map((a): [string, Record<string, unknown>] => ['BLOCK_ASN_IP', { asns: [a] }]),
      ['BLOCK_ASN_IP', { cidrs: ['10.0.0.0/8'], note: '모르는 칸' }],
      ['ADMISSION_TARGET', { eventId: randomUUID(), target: 3_000, step: 10 }],
      ['ADMISSION_TARGET', { eventId: randomUUID(), target: 3_000.5 }],
      ['ADMISSION_PAUSE', { eventId: randomUUID(), expiresAt: iso(NOW + MIN) }],
    ];
    for (const [type, params] of invalid) {
      const label = `${type} ${JSON.stringify(params)}`;
      const body = type === 'BLOCK_ASN_IP' ? { type, reason: '허용 목록', params: { ...params, expiresAt: iso(NOW + HOUR) } } : { type, reason: '허용 목록', params };
      const r = await h.post('/v1/ops/commands', h.withToken(commander), body);
      expect(r.statusCode, label).toBe(422);
      expect(slug(r), label).toMatch(/invalid-command$/);
    }
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    expect(h.audit.entries).toEqual([]);
  });

  test('[ASVS v5.0.0-2.3.2] 명령 4는 만료가 필수이고 지금 + 24시간까지·항목 100개까지만 받으며 그 밖은 422 command-out-of-range다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const send = (params: Record<string, unknown>) => h.post('/v1/ops/commands', op, { type: 'BLOCK_ASN_IP', reason: '한계', params });
    const cidrs = (n: number) => Array.from({ length: n }, (_, i) => `10.${Math.floor(i / 256)}.${i % 256}.0/24`);
    for (const [label, params] of [
      ['만료 없음', { cidrs: ['10.1.0.0/16'] }],
      ['만료 = 지금', { cidrs: ['10.1.0.0/16'], expiresAt: iso(NOW) }],
      ['만료 = 지금 + 24시간 + 1ms', { cidrs: ['10.1.0.0/16'], expiresAt: iso(NOW + 24 * HOUR + 1) }],
      ['항목 101개', { cidrs: cidrs(101), expiresAt: iso(NOW + HOUR) }],
      ['항목 101개(대역 100 + ASN 1)', { cidrs: cidrs(100), asns: [64501], expiresAt: iso(NOW + HOUR) }],
    ] as const) {
      const r = await send(params);
      expect(r.statusCode, label).toBe(422);
      expect(slug(r), label).toMatch(/command-out-of-range$/);
    }
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
    const max = await send({ cidrs: ['10.1.0.0/16'], expiresAt: iso(NOW + 24 * HOUR) });
    expect([max.statusCode, json(max).state]).toEqual([201, 'ACKED']);
    const hundred = await send({ cidrs: cidrs(100), expiresAt: iso(NOW + HOUR) });
    expect([hundred.statusCode, json(hundred).state]).toEqual([201, 'ACKED']);
  });
});

describe('사건 차례와 단계 건너뛰기(ASVS 2.3.1)', () => {
  test('[ASVS v5.0.0-2.3.1] 접수는 CREATED → DRY_RUN(dry-run 기록) → 첫 상태 차례이고, 감사 기록과 DISPATCHED 사건은 실행 포트를 부르기 전에 쓰여 있다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const one = idOf(await h.post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '로그 올림', params: { service: 'queue-svc', level: 'DEBUG' } }));
    expect(h.seenAtExecute.get(one)).toEqual({ events: ['CREATED', 'DRY_RUN', 'APPROVED', 'DISPATCHED'], audits: ['COMMAND_CREATED', 'COMMAND_EXECUTION_STARTED'] });
    const events = h.store.eventsOf(one);
    expect(events.map((e) => e.type)).toEqual(['CREATED', 'DRY_RUN', 'APPROVED', 'DISPATCHED', 'ACKED']);
    expect(events.map((e) => e.dryRun !== undefined)).toEqual([false, true, false, false, false]);
    expect(events[1]!.dryRun).toMatchObject({ version: 1, approvalMode: 'ONE', reauthRequired: false });
    const commander = h.identity.ops('commander');
    const two = idOf(await h.post('/v1/ops/commands', h.withToken(commander), { type: 'BOT_LEVEL', reason: '봇', params: { level: 'AGGRESSIVE' } }));
    expect(h.store.eventsOf(two).map((e) => e.type)).toEqual(['CREATED', 'DRY_RUN', 'PENDING_APPROVAL']);
    expect(h.store.eventsOf(two)[1]!.dryRun).toMatchObject({ version: 1, approvalMode: 'TWO', reauthRequired: true });
    const none = idOf(await h.post('/v1/ops/commands', h.withToken(commander), { type: 'KILL_SWITCH', reason: '정지', params: { scope: 'PLATFORM' } }));
    expect(h.store.eventsOf(none)[1]!.dryRun).toMatchObject({ approvalMode: 'NONE', reauthRequired: true });
  });

  test('[ASVS v5.0.0-2.3.1] 단계를 건너뛰는 요청은 막힌다: 승인 전 결과 사건, 승인 대기 아닌 승인, ACKED 아닌·1회 실행 명령의 되돌리기, FAILED 아닌 재시도, 명령 2 밖의 연장', async () => {
    const h = await harness({ result: (c) => (c.type === 'SCALE_CHANGE' ? { status: 'SUCCEEDED' } : { status: 'ACKED', ackedAtMs: NOW }) });
    const commander = h.identity.ops('commander');
    const pending = idOf(await h.post('/v1/ops/commands', h.withToken(commander), { type: 'BOT_LEVEL', reason: '대기', params: { level: 'STANDARD' } }));
    const result = await h.post('/internal/v1/ops/command-events', {}, { eventKey: `r-${randomUUID()}`, kind: 'COMMAND_RESULT', commandId: pending, status: 'ACKED' });
    expect(json(result)).toEqual({ accepted: false });
    for (const [url, body, status, type] of [
      [`/v1/ops/commands/${pending}/retries`, {}, 409, /command-not-failed$/],
      [`/v1/ops/commands/${pending}/reversions`, { reason: '되돌림' }, 409, /command-not-revertible$/],
      [`/v1/ops/commands/${pending}/extensions`, { reason: '연장' }, 409, /command-not-executable$/],
    ] as const) {
      const r = await h.post(url, h.withToken(commander), body);
      expect([r.statusCode, slug(r)], url).toEqual([status, expect.stringMatching(type)]);
    }
    expect(await h.store.find(pending)).toMatchObject({ state: 'PENDING_APPROVAL', attempts: 0 });
    const op = h.identity.ops('operator');
    const acked = idOf(await h.post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '로그', params: { level: 'DEBUG' } }));
    const approveAcked = await h.post(`/v1/ops/commands/${acked}/approvals`, h.withToken(commander), {});
    expect([approveAcked.statusCode, slug(approveAcked)]).toEqual([409, expect.stringMatching(/command-not-pending$/)]);
    const oneShot = idOf(await h.post('/v1/ops/commands', op, { type: 'SCALE_CHANGE', reason: '규모', params: { eventId: randomUUID(), scale: 'LARGE' } }));
    expect((await h.store.find(oneShot))?.state).toBe('SUCCEEDED');
    const revertOneShot = await h.post(`/v1/ops/commands/${oneShot}/reversions`, op, { reason: '되돌림' });
    expect([revertOneShot.statusCode, slug(revertOneShot)]).toEqual([409, expect.stringMatching(/command-not-revertible$/)]);
    const extendLog = await h.post(`/v1/ops/commands/${acked}/extensions`, op, { reason: '연장' });
    expect([extendLog.statusCode, slug(extendLog)]).toEqual([409, expect.stringMatching(/command-not-executable$/)]);
    expect(h.calls.revert).toEqual([]);
    expect(h.calls.extend).toEqual([]);
  });
});

describe('행위자·상태 칸과 SYSTEM 자동 조치(ASVS 8.2.3)', () => {
  test('[ASVS v5.0.0-8.2.3] 접수 본문의 행위자·승인자·상태·판 번호·ack 시각 칸은 400이고 명령이 생기지 않는다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    for (const extra of [
      { state: 'APPROVED' },
      { requestedBy: randomUUID() },
      { requestedRole: 'system' },
      { approvals: [randomUUID()] },
      { actorRef: SYSTEM_REF },
      { version: 7 },
      { ackedAt: iso(NOW) },
      { commandId: randomUUID() },
    ]) {
      const r = await h.post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '칸 시험', params: { level: 'DEBUG' }, ...extra });
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
      expect(slug(r)).not.toMatch(/idempotency-key-invalid$/);
    }
    expect((await h.store.list({ limit: 100 })).items).toEqual([]);
  });

  test('[ASVS v5.0.0-8.2.3] SYSTEM은 내부 토큰을 단 자동 조치(AUTO_ACTION)만 만들고, 명령 1 목표 낮추기만 받으며, 같은 eventKey는 한 번이다', async () => {
    const internal = `it-token-${randomUUID()}`;
    vi.stubEnv('PEAKET_INTERNAL_TOKEN', internal);
    const h = await harness();
    const eventId = randomUUID();
    const eventKey = `aimd-${randomUUID()}`;
    const action = { eventKey, kind: 'AUTO_ACTION', type: 'ADMISSION_TARGET', params: { eventId, target: 3_200, fromTarget: 4_000 }, reason: 'AIMD 감축' };
    const tokenHeader = { 'x-peaket-internal-token': internal };
    const noToken = await h.post('/internal/v1/ops/command-events', {}, action);
    expect(noToken.statusCode).toBe(403);
    expect(await h.store.find(commandIdOfEventKey(eventKey))).toBeUndefined();
    const first = await h.post('/internal/v1/ops/command-events', tokenHeader, action);
    expect([first.statusCode, json(first)]).toEqual([202, { accepted: true, commandId: commandIdOfEventKey(eventKey) }]);
    const again = await h.post('/internal/v1/ops/command-events', tokenHeader, action);
    expect(json(again)).toEqual({ accepted: true, commandId: commandIdOfEventKey(eventKey) });
    const id = commandIdOfEventKey(eventKey);
    expect(await h.store.find(id)).toMatchObject({ type: 'ADMISSION_TARGET', state: 'DISPATCHED', requestedBy: '', requesterRef: SYSTEM_REF, requestedRole: 'system', approvals: [], attempts: 1 });
    expect(h.store.eventsOf(id).map((e) => [e.type, e.actorRef, e.actorRole])).toEqual([['DISPATCHED', SYSTEM_REF, 'system']]);
    expect(h.store.actors().filter((a) => a.commandId === id)).toEqual([]);
    expect((await h.store.list({ limit: 100 })).items).toHaveLength(1);
    // 올리기·같은 값·안전 하한 밖·다른 유형은 받지 않는다
    for (const [label, body] of [
      ['올리기', { ...action, eventKey: `up-${randomUUID()}`, params: { eventId, target: 4_500, fromTarget: 4_000 } }],
      ['같은 값', { ...action, eventKey: `same-${randomUUID()}`, params: { eventId, target: 4_000, fromTarget: 4_000 } }],
      ['하한 밖', { ...action, eventKey: `low-${randomUUID()}`, params: { eventId, target: 999, fromTarget: 1_500 } }],
      ['다른 유형', { ...action, eventKey: `kill-${randomUUID()}`, type: 'KILL_SWITCH', params: { scope: 'PLATFORM' } }],
    ] as const) {
      const r = await h.post('/internal/v1/ops/command-events', tokenHeader, body);
      expect(json(r), label).toEqual({ accepted: false });
    }
    expect((await h.store.list({ limit: 100 })).items).toHaveLength(1);
    // 뒤의 결과 사건(ACKED)으로 끝낸다(ADR-0340 결정 6)
    const done = await h.post('/internal/v1/ops/command-events', tokenHeader, { eventKey: `res-${randomUUID()}`, kind: 'COMMAND_RESULT', commandId: id, status: 'ACKED', ackedAt: iso(NOW) });
    expect(json(done)).toEqual({ accepted: true, commandId: id });
    expect((await h.store.find(id))?.state).toBe('ACKED');
  });
});

describe('내부 사건 길의 서버 판정(ASVS 8.3.1)', () => {
  test('[ASVS v5.0.0-8.3.1] 내부 사건 길도 서버가 역할·요청자 분리를 판정한다(commander 전용 유형의 operator 요청·viewer 요청은 받지 않고, 판매 중지는 operator 요청을 받아 요청자 아닌 commander가 재인증해 승인하며, 내부로 만든 2인 명령도 요청자 본인은 승인하지 못한다)', async () => {
    const h = await harness();
    const post = (body: Record<string, unknown>) => h.post('/internal/v1/ops/command-events', {}, body);
    const ask = (over: Record<string, unknown>) => ({ eventKey: `ev-${randomUUID()}`, kind: 'COMMAND_REQUESTED', reason: '내부 요청', requestedBy: randomUUID(), ...over });
    for (const body of [
      ask({ type: 'KILL_SWITCH', params: { scope: 'PLATFORM' }, requestedRole: 'operator' }),
      ask({ type: 'BOT_LEVEL', params: { level: 'AGGRESSIVE' }, requestedRole: 'operator' }),
      ask({ type: 'LOG_LEVEL', params: { level: 'DEBUG' }, requestedRole: 'viewer' }),
    ]) {
      expect(json(await post(body)), JSON.stringify(body)).toEqual({ accepted: false });
      expect(await h.store.find(commandIdOfEventKey(body.eventKey as string))).toBeUndefined();
    }
    const requester = randomUUID();
    const session = randomUUID();
    h.identity.answers.set(`${requester}/${session}`, { valid: true, role: 'commander' });
    const asRequester = { 'x-user-id': requester, 'x-session-id': session, 'x-user-aud': 'ops', 'x-user-scope': '' };
    const body = ask({ type: 'BOT_LEVEL', params: { level: 'AGGRESSIVE' }, requestedRole: 'commander', requestedBy: requester });
    const accepted = await post(body);
    expect(json(accepted)).toEqual({ accepted: true, commandId: commandIdOfEventKey(body.eventKey as string) });
    const id = commandIdOfEventKey(body.eventKey as string);
    expect((await h.store.find(id))?.state).toBe('PENDING_APPROVAL');
    const self = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(asRequester), {});
    expect([self.statusCode, slug(self)]).toEqual([403, expect.stringMatching(/command-requester-cannot-approve$/)]);
    expect(json(await post({ eventKey: `res-${randomUUID()}`, kind: 'COMMAND_RESULT', commandId: id, status: 'SUCCEEDED' }))).toEqual({ accepted: false });
    expect(await h.store.find(id)).toMatchObject({ state: 'PENDING_APPROVAL', approvals: [] });

    // 판매 중지·재개는 operator 이상이 요청한다(POL-038 ⑩, ADR-0123 결정 2): 내부 사건 길도 받는다.
    const operator = randomUUID();
    const operatorSession = randomUUID();
    h.identity.answers.set(`${operator}/${operatorSession}`, { valid: true, role: 'operator' });
    const asOperator = { 'x-user-id': operator, 'x-session-id': operatorSession, 'x-user-aud': 'ops', 'x-user-scope': '' };
    const stopBody = ask({ type: 'SALE_STOP', params: { eventId: randomUUID() }, requestedBy: operator, requestedRole: 'operator' });
    expect(json(await post(stopBody))).toEqual({ accepted: true, commandId: commandIdOfEventKey(stopBody.eventKey as string) });
    const stopId = commandIdOfEventKey(stopBody.eventKey as string);
    expect(await h.store.find(stopId)).toMatchObject({ state: 'PENDING_APPROVAL', requestedRole: 'operator', approvals: [] });
    // operator는 승인 역할이 아니다(자기 요청 포함). commander는 재인증 뒤에만 승인한다.
    const opSelf = await h.post(`/v1/ops/commands/${stopId}/approvals`, h.withToken(asOperator), {});
    expect([opSelf.statusCode, slug(opSelf)]).toEqual([403, expect.stringMatching(/command-role-forbidden$/)]);
    const commander = h.identity.ops('commander');
    const noToken = await h.post(`/v1/ops/commands/${stopId}/approvals`, commander, {});
    expect([noToken.statusCode, slug(noToken)]).toEqual([403, expect.stringMatching(/reauth-required$/)]);
    const approved = await h.post(`/v1/ops/commands/${stopId}/approvals`, h.withToken(commander), {});
    expect([approved.statusCode, json(approved).state]).toEqual([200, 'SUCCEEDED']);
    // 반려: operator는 역할 밖 403, 요청자 아닌 commander는 사유를 남겨 REJECTED로 닫는다.
    const resumeBody = ask({ type: 'SALE_RESUME', params: { eventId: randomUUID() }, requestedBy: operator, requestedRole: 'operator' });
    expect(json(await post(resumeBody))).toEqual({ accepted: true, commandId: commandIdOfEventKey(resumeBody.eventKey as string) });
    const resumeId = commandIdOfEventKey(resumeBody.eventKey as string);
    const opReject = await h.post(`/v1/ops/commands/${resumeId}/rejections`, h.withToken(asOperator), { reason: 'operator 반려' });
    expect([opReject.statusCode, slug(opReject)]).toEqual([403, expect.stringMatching(/command-role-forbidden$/)]);
    const rejected = await h.post(`/v1/ops/commands/${resumeId}/rejections`, commander, { reason: '중복 요청' });
    expect([rejected.statusCode, json(rejected).state]).toEqual([200, 'REJECTED']);
    expect(h.calls.execute).toEqual([stopId]);
  });
});

describe('멱등(OPS-260, ADR-0340 결정 7)', () => {
  test('OPS-260 같은 Idempotency-Key·같은 본문은 같은 명령이고 사건·감사·실행이 늘지 않으며 재인증을 다시 보지 않고, 다른 본문은 422 idempotency-key-reused, 키가 없거나 틀리면 400이다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const key = randomUUID();
    const body = { type: 'KILL_SWITCH', reason: '긴급 정지', params: { scope: 'PLATFORM' } };
    const first = await h.post('/v1/ops/commands', h.withToken(commander), body, { 'idempotency-key': key });
    expect(first.statusCode, first.payload).toBe(201);
    const id = idOf(first);
    const events = h.store.eventsOf(id).length;
    const audits = h.audit.entries.length;
    // 재인증 토큰 없이 다시 보내도 처음 명령을 돌려준다(새 일을 하지 않으므로 재인증을 다시 보지 않는다)
    const replay = await h.post('/v1/ops/commands', commander, body, { 'idempotency-key': key });
    expect([replay.statusCode, idOf(replay)]).toEqual([201, id]);
    expect(h.store.eventsOf(id)).toHaveLength(events);
    expect(h.audit.entries).toHaveLength(audits);
    expect(h.calls.execute).toEqual([id]);
    const reused = await h.post('/v1/ops/commands', h.withToken(commander), { ...body, reason: '다른 사유' }, { 'idempotency-key': key });
    expect([reused.statusCode, slug(reused)]).toEqual([422, expect.stringMatching(/idempotency-key-reused$/)]);
    // 범위는 부른 계정 × 작업 × 키다: 다른 commander의 같은 키는 새 명령이다
    const other = h.identity.ops('commander');
    const otherFirst = await h.post('/v1/ops/commands', h.withToken(other), body, { 'idempotency-key': key });
    expect(otherFirst.statusCode).toBe(201);
    expect(idOf(otherFirst)).not.toBe(id);
    for (const [label, headers] of [
      ['키 없음', { 'idempotency-key': '' }],
      ['UUID 아님', { 'idempotency-key': 'not-a-uuid' }],
    ] as const) {
      const r = await h.post('/v1/ops/commands', h.withToken(commander), { type: 'LOG_LEVEL', reason: label, params: { level: 'DEBUG' } }, headers);
      expect([r.statusCode, slug(r)], label).toEqual([400, expect.stringMatching(/idempotency-key-invalid$/)]);
    }
    // 처음 요청이 재인증에서 막혔으면 기록이 없어 같은 키의 다시 보내기도 처음처럼 본다
    const blockedKey = randomUUID();
    expect((await h.post('/v1/ops/commands', commander, body, { 'idempotency-key': blockedKey })).statusCode).toBe(403);
    const afterBlocked = await h.post('/v1/ops/commands', h.withToken(commander), body, { 'idempotency-key': blockedKey });
    expect(afterBlocked.statusCode).toBe(201);
    expect((await h.store.list({ limit: 100 })).items).toHaveLength(3);
  });
});

describe('되돌리기·연장·자동 만료(OPS-260, ADR-0340 결정 5)', () => {
  test('OPS-260 1인 카탈로그 명령의 되돌리기는 200 REVERTED이고, 보내지 못하면 ACKED 그대로·REVERT_FAILED·502 command-dispatch-failed다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const id = idOf(await h.post('/v1/ops/commands', op, { type: 'LOBBY_BANNER', reason: '공지', params: { templateId: 'maintenance' } }));
    h.sendResult = { status: 'FAILED', error: 'queue-svc 503' };
    const failed = await h.post(`/v1/ops/commands/${id}/reversions`, op, { reason: '공지 내리기' });
    expect([failed.statusCode, slug(failed)]).toEqual([502, expect.stringMatching(/command-dispatch-failed$/)]);
    expect((await h.store.find(id))?.state).toBe('ACKED');
    expect(h.store.eventsOf(id).at(-1)).toMatchObject({ type: 'REVERT_FAILED', reason: 'queue-svc 503' });
    h.sendResult = { status: 'ACKED' };
    const ok = await h.post(`/v1/ops/commands/${id}/reversions`, op, { reason: '공지 내리기' });
    expect([ok.statusCode, json(ok).state]).toEqual([200, 'REVERTED']);
    expect(h.calls.revert).toEqual([id, id]);
    // 다시 되돌릴 수 없다(ACKED만)
    expect((await h.post(`/v1/ops/commands/${id}/reversions`, op, { reason: '또' })).statusCode).toBe(409);
  });

  test('OPS-260 명령 2는 첫 ack + 10분에 만료되고, 만료 전 연장은 지금 + 10분이며(실패면 만료 그대로·502), 만료 − 1ms에는 아니고 만료 시각에 AUTO_EXPIRED(SYSTEM)다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    const created = await h.post('/v1/ops/commands', op, { type: 'ADMISSION_PAUSE', reason: '입장 멈춤', params: { eventId } });
    expect(json(created)).toMatchObject({ state: 'ACKED', ackedAt: iso(NOW), expiresAt: iso(NOW + 10 * MIN) });
    const id = idOf(created);
    h.clock.advance(4 * MIN);
    h.sendResult = { status: 'FAILED', error: 'admission-ctrl down' };
    const failed = await h.post(`/v1/ops/commands/${id}/extensions`, op, { reason: '연장' });
    expect([failed.statusCode, slug(failed)]).toEqual([502, expect.stringMatching(/command-dispatch-failed$/)]);
    expect((await h.store.find(id))?.expiresAtMs).toBe(NOW + 10 * MIN);
    h.sendResult = { status: 'ACKED' };
    const extended = await h.post(`/v1/ops/commands/${id}/extensions`, op, { reason: '연장' });
    expect([extended.statusCode, json(extended).expiresAt]).toEqual([200, iso(NOW + 4 * MIN + 10 * MIN)]);
    const expiry = NOW + 14 * MIN;
    expect(await h.maintain.runOnce(expiry - 1)).toMatchObject({ autoExpired: 0 });
    expect((await h.store.find(id))?.state).toBe('ACKED');
    expect(await h.maintain.runOnce(expiry)).toMatchObject({ autoExpired: 1 });
    expect((await h.store.find(id))?.state).toBe('AUTO_EXPIRED');
    expect(h.store.eventsOf(id).at(-1)).toMatchObject({ type: 'AUTO_EXPIRED', actorRef: SYSTEM_REF, actorRole: 'system' });
    // 끝난 명령은 연장하지 못한다
    expect((await h.post(`/v1/ops/commands/${id}/extensions`, op, { reason: '늦은 연장' })).statusCode).toBe(409);
  });

  test('OPS-260 명령 8은 첫 ack + 30분에 AUTO_EXPIRED(SYSTEM)이고 30분 − 1ms에는 아니다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const created = await h.post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '로그', params: { service: 'ops-svc', level: 'TRACE' } });
    expect(json(created)).toMatchObject({ state: 'ACKED', expiresAt: iso(NOW + 30 * MIN) });
    const id = idOf(created);
    expect(await h.maintain.runOnce(NOW + 30 * MIN - 1)).toMatchObject({ autoExpired: 0 });
    expect(await h.maintain.runOnce(NOW + 30 * MIN)).toMatchObject({ autoExpired: 1 });
    expect(await h.store.find(id)).toMatchObject({ state: 'AUTO_EXPIRED' });
  });
});

describe('사람 칸의 가명 참조와 대응 행 지우기(ASVS 16.2.1, ADR-0149·0340 결정 8)', () => {
  test('[ASVS v5.0.0-16.2.1] 명령 기록은 가명 참조·역할·사유·승인자·dry-run·ack 시각을 담고 관리 계정 ID는 대응 표에만 있으며, 3년 지난 대응 행만 모두 지운다(보류 행은 남기고 기록·체인은 그대로)', async () => {
    const h = await harness();
    const requester = h.identity.ops('commander');
    const approver = h.identity.ops('commander');
    const id = idOf(await h.post('/v1/ops/commands', h.withToken(requester), { type: 'DEGRADED_MODE', reason: '결제사 장애', params: { mode: 'PAYMENT' } }));
    await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {});
    const accounts = [requester['x-user-id']!, approver['x-user-id']!];
    const events = h.store.eventsOf(id);
    expect(events.map((e) => e.type)).toEqual(['CREATED', 'DRY_RUN', 'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'ACKED']);
    for (const e of events) {
      expect(e.actorRef === SYSTEM_REF || UUID_V4.test(e.actorRef), e.type).toBe(true);
      expect(accounts, e.type).not.toContain(e.actorRef);
    }
    // 요청 한 행위는 한 참조, 승인은 새 참조(docs/data.md command_event.actor_ref)
    const requesterRef = h.store.requesterRefOf(id)!;
    expect(events.slice(0, 3).map((e) => e.actorRef)).toEqual([requesterRef, requesterRef, requesterRef]);
    expect(events[3]!.actorRef).not.toBe(requesterRef);
    expect(events.map((e) => e.actorRole)).toEqual(['commander', 'commander', 'commander', 'commander', 'system', 'system']);
    const payloads = JSON.stringify(h.audit.entries.filter((e) => e.recordId === id).map((e) => e.record.payload));
    for (const a of accounts) expect(payloads).not.toContain(a);
    expect(h.store.actors().filter((a) => a.commandId === id).map((a) => [a.actorRef, a.side, a.adminAccountId])).toEqual([
      [requesterRef, 'REQUESTER', accounts[0]],
      [events[3]!.actorRef, 'APPROVER', accounts[1]],
    ]);
    const detail = json(await h.get(`/v1/ops/commands/${id}`, approver));
    expect(detail).toMatchObject({ reason: '결제사 장애', requestedBy: { adminAccountId: accounts[0], role: 'commander' }, approvals: [accounts[1]], ackedAt: iso(NOW) });
    expect(detail.dryRun).toMatchObject({ version: 1, approvalMode: 'TWO' });

    // 3년 [가정](ADR-0149 결정 3). 보류가 걸린 승인자 행은 남긴다. 시험의 정비 간격은 기본(하루)과 다르게 1ms로 둔다
    const held = h.store.actors().find((a) => a.side === 'APPROVER' && a.commandId === id)!;
    held.deleteHoldRef = randomUUID();
    // 정비 한 바퀴가 다른 일(승인 기한·자동 만료)을 하지 않도록 만료 없는 1인 명령(명령 7)을 더한다
    const sameDay = idOf(await h.post('/v1/ops/commands', requester, { type: 'LOBBY_BANNER', reason: '같은 날 명령', params: { templateId: 'notice-1' } }));
    h.clock.advance(24 * HOUR);
    const later = idOf(await h.post('/v1/ops/commands', requester, { type: 'LOBBY_BANNER', reason: '하루 뒤 명령', params: { templateId: 'notice-2' } }));
    const threeYears = 3 * 365 * 24 * HOUR;
    const purge = new MaintainCommands(h.store, new ComputeDryRun(), { actorPurgeIntervalMs: 1 });
    const auditBefore = h.audit.entries.length;
    expect((await purge.runOnce(NOW + threeYears)).actorsPurged).toBe(0);
    // 3년이 지난 행은 모두(두 명령의 요청자) 지우고, 보류 행과 하루 뒤 행은 남긴다
    expect((await purge.runOnce(NOW + threeYears + 1)).actorsPurged).toBe(2);
    expect(h.store.actors().map((a) => [a.commandId, a.side])).toEqual([
      [id, 'APPROVER'],
      [later, 'REQUESTER'],
    ]);
    expect(h.store.eventsOf(id)).toEqual(events);
    expect(h.audit.entries).toHaveLength(auditBefore);
    // 대응이 지워지면 역할만 보인다(ADR-0149 결정 4)
    expect(json(await h.get(`/v1/ops/commands/${id}`, approver))).toMatchObject({ requestedBy: { displayName: null, role: 'commander' }, approvals: [accounts[1]] });
    expect((json(await h.get(`/v1/ops/commands/${id}`, approver)).requestedBy as Record<string, unknown>).adminAccountId).toBeUndefined();
    expect((json(await h.get(`/v1/ops/commands/${sameDay}`, approver)).requestedBy as Record<string, unknown>).adminAccountId).toBeUndefined();
    expect(json(await h.get(`/v1/ops/commands/${later}`, approver))).toMatchObject({ requestedBy: { adminAccountId: accounts[0], role: 'commander' } });
  });
});

describe('리뷰 반영 재현(BAT-355 리뷰 RV-02·RV-03)', () => {
  test('OPS-260 RV-02 [ASVS v5.0.0-16.2.1] 실행 전후 감사 체크포인트의 actorRef는 관리 계정 ID가 아니라 그 실행(DISPATCHED 사건)의 가명 참조다(처음 실행은 SYSTEM 빈 UUID, 다시 한 실행은 그 사람의 ACTOR 참조, B18·ADR-0149 결정 3·ADR-0340 결정 8)', async () => {
    let failFirst = true;
    const h = await harness({
      result: (c) => {
        if (c.type === 'LOBBY_BANNER' && failFirst) {
          failFirst = false;
          return { status: 'FAILED', error: 'queue-svc 503' };
        }
        return { status: 'ACKED', ackedAtMs: NOW };
      },
    });
    const viewer = h.identity.ops('viewer');
    const checkpoints = async () => (json(await h.get('/v1/ops/audit-checkpoints?limit=100', viewer)).items as Array<{ actorRef: string; reason: string }>) ?? [];
    // 처음 실행: 요청한 operator가 아니라 SYSTEM이 보낸다(DISPATCHED 사건의 행위자)
    const operator = h.identity.ops('operator');
    const once = idOf(await h.post('/v1/ops/commands', operator, { type: 'LOG_LEVEL', reason: '로그', params: { level: 'DEBUG' } }));
    expect(h.store.eventsOf(once).find((e) => e.type === 'DISPATCHED')?.actorRef).toBe(SYSTEM_REF);
    const first = await checkpoints();
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((c) => c.actorRef)).toEqual(first.map(() => SYSTEM_REF));
    // 실패 뒤 다른 operator가 다시 보낸다: 체크포인트의 행위자는 그 사람의 가명 참조(대응 표 ACTOR)다
    const retrier = h.identity.ops('operator');
    const failed = idOf(await h.post('/v1/ops/commands', operator, { type: 'LOBBY_BANNER', reason: '공지', params: { templateId: 'notice-rv02' } }));
    expect((await h.store.find(failed))?.state).toBe('FAILED');
    const retried = await h.post(`/v1/ops/commands/${failed}/retries`, retrier, {});
    expect([retried.statusCode, json(retried).state]).toEqual([200, 'ACKED']);
    const actorRefs = h.store.actors().filter((a) => a.commandId === failed && a.side === 'ACTOR').map((a) => a.actorRef);
    expect(actorRefs).toHaveLength(1);
    const all = await checkpoints();
    for (const c of all) {
      expect([operator['x-user-id'], retrier['x-user-id']], c.reason).not.toContain(c.actorRef);
      expect([SYSTEM_REF, ...actorRefs], c.reason).toContain(c.actorRef);
    }
    const text = JSON.stringify(all);
    expect(text).not.toContain(operator['x-user-id']!);
    expect(text).not.toContain(retrier['x-user-id']!);
  });

  test('OPS-260 RV-03 명령 6(Degraded Mode) 해제(되돌리기)는 commander 1인이 재인증해야 하고, 토큰 없이·패스키 없이 보내면 403 reauth-required이며 되돌리기 사건·감사·실행이 0건이다(control-tower §3 명령 6, ADR-0105)', async () => {
    const h = await harness();
    const requester = h.identity.ops('commander');
    const id = idOf(await h.post('/v1/ops/commands', h.withToken(requester), { type: 'DEGRADED_MODE', reason: '결제사 장애', params: { mode: 'PAYMENT' } }));
    const approver = h.identity.ops('commander');
    expect(json(await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(approver), {})).state).toBe('ACKED');
    const events = h.store.eventsOf(id).length;
    const audits = h.audit.entries.filter((e) => e.recordId === id).length;
    for (const [label, headers] of [
      ['토큰 없음', approver],
      ['패스키 없음', h.withToken(approver, { factors: ['password', 'totp'] })],
    ] as const) {
      const r = await h.post(`/v1/ops/commands/${id}/reversions`, headers, { reason: 'Degraded Mode 모두 해제' });
      expect([r.statusCode, slug(r)], label).toEqual([403, expect.stringMatching(/reauth-required$/)]);
    }
    expect((await h.store.find(id))?.state).toBe('ACKED');
    expect(h.store.eventsOf(id)).toHaveLength(events);
    expect(h.audit.entries.filter((e) => e.recordId === id)).toHaveLength(audits);
    expect(h.calls.revert).toEqual([]);
    // 재인증한 commander 1인이면 해제를 보낸다(2인 승인 없음)
    const ok = await h.post(`/v1/ops/commands/${id}/reversions`, h.withToken(approver), { reason: 'Degraded Mode 모두 해제' });
    expect([ok.statusCode, json(ok).state]).toEqual([200, 'REVERTED']);
    expect(h.calls.revert).toEqual([id]);
  });
});
