// 명령 3·11 사후 검토 보고서(할 일·제출·검토·기한·조회)를 바깥 HTTP 경계와 정비 바퀴 진입점으로 본다(BAT-360 OPS-290, ADR-0349 결정 7, 계획 6절 B19~B22).
// 정본 값: 대상은 승인 없이 실행한 명령 3(KILL_SWITCH)·11(AUTOMATION_STOP), 작성 기한 처음 DISPATCHED + 48시간, 검토 기한 제출 + 7일, 정각이면 넘김,
// 넘기면 SEV3 ops 경보 post-review-overdue·post-review-confirm-overdue(명령마다 하나), 늦은 제출·검토도 받아 late,
// 제출은 실행한 commander만(403 post-review-not-executor), 검토는 실행자 아닌 commander만(403 post-review-self-confirm),
// 활성 commander가 실행자 한 명뿐이면(identity ListAdminAccounts) 실행자 검토를 받아 '1인 기간 자기 검토'로 남기고, identity에 닿지 못하면 503(control-tower §6 첫 구현),
// 글은 NFC 한 번 뒤 2,000자, 제어 문자·양방향 제어 문자가 있으면 422, 명령 11은 whyNoSecondApproval 필수·계기는 명령마다(openapi post-review 본문), 조회는 viewer 이상.
// 1인 기간 판정은 제품 IdentityActiveCommanders를 관리 계정 identity 짝 가짜(FakeAdminIdentity)에 물린다. 경보는 메모리 경보 저장소를 통과 감시로 감싸 연 횟수를 센다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem } from '../src/modules/admin-accounts/index.js';
import { MemoryOpsAlertStore, type OpsAlert, type OpsAlertStore } from '../src/modules/alerts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MaintainCommands, type CommandExecutor } from '../src/modules/commands/index.js';
import { FakeAdminIdentity, reauthKit, type ReauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T03:00:00.000Z');
const HOUR = 60 * 60_000;
/** 정본 기한(ADR-0349 결정 7) */
const DUE = 48 * HOUR;
const CONFIRM_DUE = 7 * 24 * HOUR;
type Headers = Record<string, string>;

/** 메모리 경보 저장소를 그대로 부르며 연 횟수만 센다(통과 감시) */
class CountingAlerts implements OpsAlertStore {
  readonly inner = new MemoryOpsAlertStore();
  readonly opens: { kind: string; eventKey: string; severity: string }[] = [];
  async open(input: Parameters<OpsAlertStore['open']>[0]): Promise<OpsAlert> {
    this.opens.push({ kind: input.kind, eventKey: input.eventKey, severity: input.severity });
    return this.inner.open(input);
  }
  resolve(input: Parameters<OpsAlertStore['resolve']>[0]): Promise<OpsAlert | undefined> {
    return this.inner.resolve(input);
  }
}

interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly admin: FakeAdminIdentity;
  readonly kit: ReauthKit;
  readonly audit: MemoryAuditChain;
  readonly alerts: CountingAlerts;
  readonly maintain: MaintainCommands;
  post(url: string, who: Headers, body: unknown): Promise<{ statusCode: number; payload: string }>;
  get(url: string, who: Headers): Promise<{ statusCode: number; payload: string }>;
  withToken(who: Headers): Headers;
  /** identity 활성 OPS commander로 올린다 */
  commander(): Headers;
}

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
});

async function harness(): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const admin = new FakeAdminIdentity();
  const kit = reauthKit(() => clock.now());
  const audit = new MemoryAuditChain();
  const alerts = new CountingAlerts();
  const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, executor, auditChain: audit, adminAccounts: { identity: admin, reauth: kit.verifier }, commandExtras: { postReviews: { alerts } } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const h: Harness = {
    svc,
    clock,
    identity,
    admin,
    kit,
    audit,
    alerts,
    maintain: svc.app.get(MaintainCommands),
    post: (url, who, body) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url, who) => svc.http.inject({ method: 'GET', url, headers: who }),
    withToken: (who) => ({ ...who, 'x-reauth-token': kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'OPS_COMMAND' }) }),
    commander: () => {
      const who = identity.ops('commander');
      admin.seed({ adminAccountId: who['x-user-id']!, role: 'commander' });
      return who;
    },
  };
  opened.push(h);
  return h;
}

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '').split('/').pop();
const iso = (ms: number) => new Date(ms).toISOString();
const KILL = { type: 'KILL_SWITCH', reason: '오버셀 의심으로 멈춤', params: { scope: 'PLATFORM' } };
const STOP = { type: 'AUTOMATION_STOP', reason: '지표 입력 오류', params: {} };
const report = (o: Record<string, unknown> = {}) => ({ trigger: 'MONEY_OR_SEAT_SUSPICION', triggerDetail: '결제-발권 불일치 경보를 보고 멈췄다', followUps: [], ...o });
const confirmation = (o: Record<string, unknown> = {}) => ({ assessment: 'APPROPRIATE', comment: '정지 판단이 맞았다', ...o });

/** 명령 3을 1인 실행해 할 일을 연다 */
async function killBy(h: Harness, who: Headers): Promise<string> {
  const r = await h.post('/v1/ops/commands', h.withToken(who), KILL);
  expect(r.statusCode, r.payload).toBe(201);
  expect(json(r).state).toBe('ACKED');
  return json(r).commandId as string;
}

describe('C-T46 ② 할 일 열기(ADR-0349 결정 7, B19)', () => {
  test('C-T46 ② 1인 실행한 명령 3에 할 일(작성 48시간)이 하나 생긴다', async () => {
    const h = await harness();
    const executor = h.commander();
    h.clock.advance(17_000);
    const dispatchedAt = h.clock.now();
    const id = await killBy(h, executor);
    const viewer = h.identity.ops('viewer');
    const r = await h.get(`/v1/ops/commands/${id}/post-review`, viewer);
    expect(r.statusCode, r.payload).toBe(200);
    expect(json(r)).toMatchObject({ commandId: id, type: 'KILL_SWITCH', dueAt: iso(dispatchedAt + DUE), submittedAt: null, report: null, late: false, soloSelfReview: false });
    // 명령 상태의 postReviewDueAt도 같은 값이다(ADR-0349 결정 12)
    expect(json(await h.get(`/v1/ops/commands/${id}`, h.identity.ops('operator'))).postReviewDueAt).toBe(iso(dispatchedAt + DUE));
    // 할 일은 하나다(정비 바퀴가 다시 열지 않는다)
    await h.maintain.runOnce(h.clock.now());
    expect(h.audit.entries.filter((e) => e.recordId === id && e.recordType === 'POST_REVIEW_OPENED')).toHaveLength(1);
  });

  test('C-T46 ② 명령 11도 할 일이 생기고, 승인을 거치는 명령(판매 중지·명령 1)에는 할 일이 없다(404)', async () => {
    const h = await harness();
    const commander = h.commander();
    const other = h.commander();
    const stop = await h.post('/v1/ops/commands', h.withToken(commander), STOP);
    expect(stop.statusCode, stop.payload).toBe(201);
    const stopId = json(stop).commandId as string;
    expect(json(await h.get(`/v1/ops/commands/${stopId}/post-review`, commander))).toMatchObject({ type: 'AUTOMATION_STOP', dueAt: iso(NOW + DUE) });

    const sale = await h.post('/v1/ops/commands', h.withToken(commander), { type: 'SALE_STOP', reason: '판매 중지', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } });
    const saleId = json(sale).commandId as string;
    expect((await h.post(`/v1/ops/commands/${saleId}/approvals`, h.withToken(other), {})).statusCode).toBe(200);
    expect((await h.get(`/v1/ops/commands/${saleId}/post-review`, commander)).statusCode).toBe(404);
    const target = await h.post('/v1/ops/commands', commander, { type: 'ADMISSION_TARGET', reason: '목표 조정', params: { eventId: randomUUID(), target: 3_000 } });
    expect((await h.get(`/v1/ops/commands/${json(target).commandId as string}/post-review`, commander)).statusCode).toBe(404);
  });
});

describe('C-T10 ② 제출·검토 권한(ADR-0349 결정 7, B20)', () => {
  test('[ASVS v5.0.0-8.2.2] 제출은 실행한 commander만: 다른 commander 403 post-review-not-executor, operator 403, 실행자는 201', async () => {
    const h = await harness();
    const executor = h.commander();
    const other = h.commander();
    const op = h.identity.ops('operator');
    const id = await killBy(h, executor);
    const byOther = await h.post(`/v1/ops/commands/${id}/post-review`, other, report());
    expect(byOther.statusCode).toBe(403);
    expect(slug(byOther)).toBe('post-review-not-executor');
    expect((await h.post(`/v1/ops/commands/${id}/post-review`, op, report())).statusCode).toBe(403);
    expect(json(await h.get(`/v1/ops/commands/${id}/post-review`, other)).submittedAt).toBeNull();
    const ok = await h.post(`/v1/ops/commands/${id}/post-review`, executor, report());
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(json(ok)).toMatchObject({ submittedAt: iso(NOW), confirmDueAt: iso(NOW + CONFIRM_DUE), late: false, report: { trigger: 'MONEY_OR_SEAT_SUSPICION' } });
    // 두 번 제출은 409
    const again = await h.post(`/v1/ops/commands/${id}/post-review`, executor, report());
    expect(again.statusCode).toBe(409);
  });

  test('C-T10 ② 실행자 검토는 403, 1인 기간만 받는다: 활성 commander가 둘이면 실행자 403 post-review-self-confirm, 다른 commander는 받는다', async () => {
    const h = await harness();
    const executor = h.commander();
    const other = h.commander();
    const id = await killBy(h, executor);
    expect((await h.post(`/v1/ops/commands/${id}/post-review`, executor, report())).statusCode).toBe(201);
    const self = await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, executor, confirmation());
    expect(self.statusCode).toBe(403);
    expect(slug(self)).toBe('post-review-self-confirm');
    expect(json(await h.get(`/v1/ops/commands/${id}/post-review`, other)).confirmedAt).toBeNull();
    const ok = await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, other, confirmation({ assessment: 'INCONCLUSIVE' }));
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok)).toMatchObject({ confirmedAt: iso(NOW), assessment: 'INCONCLUSIVE', soloSelfReview: false, comment: '정지 판단이 맞았다' });
    const rec = h.audit.entries.find((e) => e.recordId === id && e.recordType === 'POST_REVIEW_CONFIRMED');
    expect(rec?.record.payload).toMatchObject({ soloSelfReview: false });
    expect(rec?.record.payload.note).toBeUndefined();
    // 두 번 검토는 409
    expect((await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, other, confirmation())).statusCode).toBe(409);
  });

  test('C-T10 ② 1인 기간(활성 commander가 실행자 한 명뿐)에는 실행자 검토를 받고 감사 기록에 1인 기간 자기 검토를 남긴다', async () => {
    const h = await harness();
    const executor = h.commander();
    // 활성이 아닌 commander와 다른 역할은 세지 않는다
    h.admin.seed({ adminAccountId: randomUUID(), role: 'commander', status: 'REMOVED' });
    h.admin.seed({ adminAccountId: randomUUID(), role: 'commander', status: 'INVITED' });
    h.admin.seed({ adminAccountId: randomUUID(), role: 'operator' });
    const id = await killBy(h, executor);
    expect((await h.post(`/v1/ops/commands/${id}/post-review`, executor, report())).statusCode).toBe(201);
    const ok = await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, executor, confirmation());
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok)).toMatchObject({ soloSelfReview: true, assessment: 'APPROPRIATE' });
    const rec = h.audit.entries.find((e) => e.recordId === id && e.recordType === 'POST_REVIEW_CONFIRMED');
    expect(rec?.record.payload).toMatchObject({ soloSelfReview: true, note: '1인 기간 자기 검토' });
  });

  test('C-T10 ② identity에 닿지 못하면 1인 기간으로 보지 않고 503이며 검토가 남지 않는다(M3)', async () => {
    const h = await harness();
    const executor = h.commander();
    const id = await killBy(h, executor);
    expect((await h.post(`/v1/ops/commands/${id}/post-review`, executor, report())).statusCode).toBe(201);
    h.admin.fail = { method: 'list', problem: new AdminAccountProblem('admin-account-unavailable', 503, '관리 계정 서비스에 닿지 못했습니다') };
    const r = await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, executor, confirmation());
    expect(r.statusCode).toBe(503);
    expect(slug(r)).toBe('admin-account-unavailable');
    expect(json(await h.get(`/v1/ops/commands/${id}/post-review`, executor))).toMatchObject({ confirmedAt: null, soloSelfReview: false });
    expect(h.audit.entries.some((e) => e.recordId === id && e.recordType === 'POST_REVIEW_CONFIRMED')).toBe(false);
  });

  test('C-T10 ② 제출 전 검토는 409, 조회는 viewer 이상(cs_agent 403)', async () => {
    const h = await harness();
    const executor = h.commander();
    const other = h.commander();
    const id = await killBy(h, executor);
    expect((await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, other, confirmation())).statusCode).toBe(409);
    expect((await h.get(`/v1/ops/commands/${id}/post-review`, h.identity.ops('viewer'))).statusCode).toBe(200);
    expect((await h.get(`/v1/ops/commands/${id}/post-review`, h.identity.ops('operator'))).statusCode).toBe(200);
    expect((await h.get(`/v1/ops/commands/${id}/post-review`, h.identity.ops('cs_agent'))).statusCode).toBe(403);
  });
});

describe('C-T10 ② 기한과 경보(ADR-0349 결정 7, B21)', () => {
  test('C-T10 ② 작성 기한 48시간: − 1ms에는 경보가 없고 정각에 SEV3 post-review-overdue가 한 번 나며, 늦은 제출도 받고 late다', async () => {
    const h = await harness();
    const executor = h.commander();
    const id = await killBy(h, executor);
    h.clock.advance(DUE - 1);
    await h.maintain.runOnce(h.clock.now());
    expect(h.alerts.opens).toEqual([]);
    h.clock.advance(1);
    await h.maintain.runOnce(h.clock.now());
    await h.maintain.runOnce(h.clock.now() + 1);
    expect(h.alerts.opens).toEqual([{ kind: 'post-review-overdue', eventKey: id, severity: 'SEV3' }]);
    const late = await h.post(`/v1/ops/commands/${id}/post-review`, executor, report());
    expect(late.statusCode, late.payload).toBe(201);
    expect(json(late)).toMatchObject({ late: true, submittedAt: iso(NOW + DUE) });
  });

  test('C-T10 ② 검토 기한 제출 + 7일: − 1ms에는 경보가 없고 정각에 SEV3 post-review-confirm-overdue가 한 번 나며, 늦은 검토도 받고 late다', async () => {
    const h = await harness();
    const executor = h.commander();
    const other = h.commander();
    const id = await killBy(h, executor);
    h.clock.advance(HOUR);
    expect((await h.post(`/v1/ops/commands/${id}/post-review`, executor, report())).statusCode).toBe(201);
    h.clock.advance(CONFIRM_DUE - 1);
    await h.maintain.runOnce(h.clock.now());
    expect(h.alerts.opens.filter((a) => a.kind === 'post-review-confirm-overdue')).toEqual([]);
    // 제출이 기한 안이라 작성 기한 경보도 없다
    expect(h.alerts.opens.filter((a) => a.kind === 'post-review-overdue')).toEqual([]);
    h.clock.advance(1);
    await h.maintain.runOnce(h.clock.now());
    await h.maintain.runOnce(h.clock.now() + 1);
    expect(h.alerts.opens).toEqual([{ kind: 'post-review-confirm-overdue', eventKey: id, severity: 'SEV3' }]);
    const late = await h.post(`/v1/ops/commands/${id}/post-review-confirmation`, other, confirmation());
    expect(late.statusCode, late.payload).toBe(200);
    expect(json(late)).toMatchObject({ late: true, confirmedAt: iso(NOW + HOUR + CONFIRM_DUE) });
  });
});

describe('B360-PR 보고서 글(openapi post-review 본문, B22)', () => {
  test('[ASVS v5.0.0-1.1.1] 분해형(NFD) 한글은 NFC로 한 번 정규화해 저장하고, 길이는 정규화 뒤에 잰다', async () => {
    const h = await harness();
    const executor = h.commander();
    const id = await killBy(h, executor);
    // '한' NFD는 3 코드 단위다. 700자 → NFD 2,100 코드 단위지만 NFC는 700자라 받아야 한다
    const nfc = '한'.repeat(700);
    const nfd = nfc.normalize('NFD');
    expect(nfd.length).toBe(2_100);
    const r = await h.post(`/v1/ops/commands/${id}/post-review`, executor, report({ triggerDetail: `  ${nfd}  ` }));
    expect(r.statusCode, r.payload).toBe(201);
    const stored = (json(r).report as Record<string, string>).triggerDetail;
    expect(stored).toBe(nfc);
    expect(stored.normalize('NFC')).toBe(stored);
  });

  test('[ASVS v5.0.0-1.3.3] 글은 2,000자까지 받고 2,001자는 422 post-review-invalid다', async () => {
    const h = await harness();
    const executor = h.commander();
    const a = await killBy(h, executor);
    const over = await h.post(`/v1/ops/commands/${a}/post-review`, executor, report({ triggerDetail: 'x'.repeat(2_001) }));
    expect(over.statusCode).toBe(422);
    expect(slug(over)).toBe('post-review-invalid');
    expect(json(over).detail).toBe('triggerDetail');
    const ok = await h.post(`/v1/ops/commands/${a}/post-review`, executor, report({ triggerDetail: 'x'.repeat(2_000) }));
    expect(ok.statusCode, ok.payload).toBe(201);
  });

  test('[ASVS v5.0.0-1.3.3] 양방향 제어 문자(U+202A~U+202E, U+2066~U+2069)와 제어 문자가 든 글은 422이고 저장되지 않는다', async () => {
    const h = await harness();
    const executor = h.commander();
    const id = await killBy(h, executor);
    const bad = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '\u0007', '\u001b', '\u0000'];
    for (const ch of bad) {
      const r = await h.post(`/v1/ops/commands/${id}/post-review`, executor, report({ triggerDetail: `정지${ch}사유` }));
      expect(r.statusCode, `U+${ch.codePointAt(0)!.toString(16)}`).toBe(422);
      expect(slug(r)).toBe('post-review-invalid');
    }
    const whyBad = await h.post(`/v1/ops/commands/${id}/post-review`, executor, report({ actionsNote: `조치‮기록` }));
    expect(whyBad.statusCode).toBe(422);
    expect(json(whyBad).detail).toBe('actionsNote');
    expect(json(await h.get(`/v1/ops/commands/${id}/post-review`, executor)).submittedAt).toBeNull();
  });

  test('B360-PR ① 명령 11은 2인 승인을 기다리지 않은 이유가 없으면 422, 명령에 맞지 않는 계기는 422이고 맞는 값은 받는다', async () => {
    const h = await harness();
    const executor = h.commander();
    const stopId = json(await h.post('/v1/ops/commands', h.withToken(executor), STOP)).commandId as string;
    const kill = await killBy(h, executor);
    const noWhy = await h.post(`/v1/ops/commands/${stopId}/post-review`, executor, report({ trigger: 'METRIC_OR_INPUT_ERROR' }));
    expect(noWhy.statusCode).toBe(422);
    expect(json(noWhy).detail).toBe('whyNoSecondApproval');
    // 명령 11에 명령 3 전용 계기, 명령 3에 명령 11 전용 계기
    const wrong11 = await h.post(`/v1/ops/commands/${stopId}/post-review`, executor, report({ trigger: 'PRICE_OR_DISPLAY_ERROR', whyNoSecondApproval: '바로 멈춰야 했다' }));
    expect(wrong11.statusCode).toBe(422);
    expect(json(wrong11).detail).toBe('trigger');
    const wrong3 = await h.post(`/v1/ops/commands/${kill}/post-review`, executor, report({ trigger: 'CONTROL_MALFUNCTION' }));
    expect(wrong3.statusCode).toBe(422);
    expect(json(wrong3).detail).toBe('trigger');
    const ok11 = await h.post(`/v1/ops/commands/${stopId}/post-review`, executor, report({ trigger: 'CONTROL_MALFUNCTION', whyNoSecondApproval: '자동 제어가 목표를 계속 낮춰 바로 멈췄다' }));
    expect(ok11.statusCode, ok11.payload).toBe(201);
    const ok3 = await h.post(`/v1/ops/commands/${kill}/post-review`, executor, report({ trigger: 'PREVENTIVE_STOP' }));
    expect(ok3.statusCode, ok3.payload).toBe(201);
  });
});
