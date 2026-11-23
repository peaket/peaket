// 명령 보내기·승인·반려·다시 시도·되돌리기의 요청 흐름(F-03-4 T4·T5·T6·T7·T8·T9·T10·T12, C-T4·C-T5·C-T7 ②·C-T46 ③④, ASVS v5.0.0-3.3.4·14.2.1, 시험 먼저 ADR 0372번).
// 정본: docs/api/openapi.yaml createOpsCommand(Idempotency-Key 필수, 위험 명령 X-Reauth-Token), createOpsCommandDryRun(재인증·멱등 키 없음),
// approvals(ReauthToken 필수, 요청자 본인 403), rejections(본문 reason), retries, reversions(명령 3·6·11은 X-Reauth-Token, 명령 3·6은 commander, 명령 3·11은 202 REVERT_PENDING),
// docs/features/control-tower.md §3 '위험 명령 재인증의 첫 구현'(act=OPS_COMMAND, jti 한 번), §4(명령 3은 승인 대기 없이 전달, ADR-0095), §12 휴대폰,
// docs/frontend.md §4.1(멱등 키는 사용자 동작 하나에 하나, 재인증 토큰은 한 번 쓰면 버리고 403 reauth-required면 재인증 뒤 새 토큰으로 한 번 다시 보낸다),
// docs/api/guidelines.md §7(재인증 토큰은 X-Reauth-Token 머리로만), docs/security/asvs/control-tower.md 3.3.4·14.2.1, 계획 docs/review/plans/F-03-4.md 1-3~1-8·6-3·6-5.
//
// 시험이 정한 공개 인터페이스(계획 §4에 없어 시험 먼저 절차에서 시험이 정했다, 계획 '시험 결과'에 적음):
//   model/command-actions.ts의 createCommandActions({ role, layout, reauth }) → { dryRun(draft), submit(draft, submission, { reauth }), approve(detail), reject(detail, reason), retry(detail), revert(detail, reason) }.
//   reauth(act)는 재인증 대화상자(CMP-064)를 띄워 토큰을 돌려주는 화면 쪽 함수다(닫으면 null). 시험은 그 자리에 실제 requestReauth(가짜 REST)를 끼운다.
//   돌려주는 값: { kind: 'done', status, command } | { kind: 'problem', status, type, message } | { kind: 'cancelled' } | { kind: 'blocked', reason } | { kind: 'invalid' } | { kind: 'busy' }.
//   dryRun은 { kind: 'ok', view }(view = dryRunView(응답)) 또는 위의 problem·blocked·invalid다.
// 가짜는 REST 경계(전역 fetch)만 쓴다. 본문 만들기·카드 상태·재인증 함수는 진짜다.
// 구현 전 트리에는 model/command-actions.ts·requestReauth가 없어 시험마다 가져오기부터 실패한다.
import { register } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C1, E, commandState, dryRunPgFallback, fakeRest, json, problem, recordStorage, reauthServer } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const PW = 'pw-Δ-secret-91';
const CODE = '482 913';
const COMMANDS = '/v1/ops/commands';
const REAUTH = '/v1/ops/auth/reauthentications';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const killDraft = (over = {}) => ({ kind: 'KILL_SWITCH', scope: 'EVENT', eventId: E, reason: '결제사 승인 지연으로 판매를 멈춥니다', ...over });
const targetDraft = (over = {}) => ({ kind: 'ADMISSION_TARGET', eventId: E, target: 5200, fromTarget: 4000, reason: '결제 대기가 줄어 목표를 올립니다', ...over });
const pgDraft = (over = {}) => ({ kind: 'PG_FALLBACK', scope: 'EVENT', eventId: E, toPg: 'PORTONE', reason: '토스 승인 지연으로 대체 결제사로 보냅니다', ...over });

/** 모듈 셋(시험마다 따로 가져와 하나가 없어도 이유가 드러난다) */
async function modules() {
  const actions = await import('./command-actions.ts');
  const form = await import('./command-form.ts');
  const reauth = await import('../../../features/admin-reauth/api.ts');
  assert.equal(typeof actions.createCommandActions, 'function', 'command-actions.ts에 createCommandActions가 없다');
  assert.equal(typeof reauth.requestReauth, 'function', 'admin-reauth/api.ts에 requestReauth가 없다');
  return { ...actions, ...form, requestReauth: reauth.requestReauth };
}

/** 재인증 대화상자 자리: 사람이 비밀번호·코드를 넣고 패스키를 마친 것처럼 실제 requestReauth를 부른다. answer가 'close'면 창을 닫는다 */
function dialog(requestReauth, answers = []) {
  const calls = [];
  const fn = async (act) => {
    calls.push(act);
    if (answers[calls.length - 1] === 'close') return null;
    return requestReauth({ act, password: PW, code: CODE });
  };
  return { fn, calls };
}

/** 가짜 서버 하나: 재인증 토큰을 새로 주고, 명령 경로마다 정한 응답을 준다 */
function server() {
  const api = fakeRest();
  const issued = reauthServer(api);
  api.install();
  return { api, issued };
}

const commandPosts = (api) => api.sent('POST', COMMANDS);

test('F-03-4 T4 C-T5 ②-1 명령 3(재인증 필요)은 보내기 전에 재인증(OPS_COMMAND)을 띄우고, 토큰을 접수 요청 하나의 X-Reauth-Token에만 싣는다', async () => {
  const m = await modules();
  const { api, issued } = server();
  api.on('POST', COMMANDS, () => json(201, commandState({ state: 'DISPATCHED', delivery: { kind: 'ACK', ackedCount: 0, targetCount: 3, unackedTargets: [] } })));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  const sub = new m.Submission();
  const out = await a.submit(killDraft(), sub, { reauth: true });
  assert.deepEqual(d.calls, ['OPS_COMMAND']);
  assert.equal(api.sent('POST', REAUTH)[0].body.act, 'OPS_COMMAND');
  const posts = commandPosts(api);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['x-reauth-token'], issued[0]);
  assert.equal(posts[0].headers['idempotency-key'], sub.idempotencyKey);
  assert.deepStrictEqual(posts[0].body, m.commandBodyOf(killDraft()));
  // 명령 3은 1인 실행: 승인 대기 없이 DISPATCHED(ADR-0095)
  assert.equal(out.kind, 'done');
  assert.equal(out.status, 201);
  assert.equal(out.command.state, 'DISPATCHED');
});

test('F-03-4 T4 C-T5 ②-2 dry-run이 재인증 필요 없음(명령 1)이면 대화상자 없이 보내고 X-Reauth-Token 머리가 없다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', COMMANDS, () => json(201, commandState({ type: 'ADMISSION_TARGET', state: 'DISPATCHED', params: { eventId: E, target: 5200, fromTarget: 4000 } })));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'operator', layout: 'desktop', reauth: d.fn });
  const out = await a.submit(targetDraft(), new m.Submission(), { reauth: false });
  assert.equal(out.kind, 'done');
  assert.deepEqual(d.calls, []);
  assert.equal(api.sent('POST', REAUTH).length, 0);
  const posts = commandPosts(api);
  assert.equal(posts.length, 1);
  assert.equal(Object.hasOwn(posts[0].headers, 'x-reauth-token'), false);
  assert.match(posts[0].headers['idempotency-key'], UUID_V4);
});

test('F-03-4 T4 C-T5 ②-3 재인증 창을 닫으면 접수 요청을 보내지 않는다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', COMMANDS, () => json(201, commandState()));
  const d = dialog(m.requestReauth, ['close']);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  const out = await a.submit(killDraft(), new m.Submission(), { reauth: true });
  assert.deepEqual(out, { kind: 'cancelled' });
  assert.equal(commandPosts(api).length, 0);
});

test('F-03-4 T4 C-T5 ②-4 서버가 403 reauth-required를 주면 토큰을 버리고 다시 재인증해 새 토큰으로 한 번만 다시 보낸다(같은 멱등 키)', async () => {
  const m = await modules();
  const { api, issued } = server();
  api.on('POST', COMMANDS, [() => problem(403, 'reauth-required'), () => json(201, commandState({ state: 'DISPATCHED' }))]);
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  const sub = new m.Submission();
  const out = await a.submit(killDraft(), sub, { reauth: true });
  assert.deepEqual(d.calls, ['OPS_COMMAND', 'OPS_COMMAND']);
  const posts = commandPosts(api);
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((p) => p.headers['x-reauth-token']),
    [issued[0], issued[1]],
  );
  assert.notEqual(issued[0], issued[1]);
  assert.deepEqual(
    posts.map((p) => p.headers['idempotency-key']),
    [sub.idempotencyKey, sub.idempotencyKey],
  );
  assert.equal(out.kind, 'done');
});

test('F-03-4 T4 C-T5 ②-5 다시 보낸 것도 403 reauth-required면 더 보내지 않고 문제 글로 끝나며 화면은 보냄이 되지 않는다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', COMMANDS, () => problem(403, 'reauth-required'));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  const out = await a.submit(killDraft(), new m.Submission(), { reauth: true });
  assert.equal(commandPosts(api).length, 2);
  assert.equal(out.kind, 'problem');
  assert.equal(out.status, 403);
  assert.equal(out.type, 'reauth-required');
  assert.match(out.message, /다시 로그인한 확인이 만료되었거나 이미 쓰였습니다/);
});

test('F-03-4 T7 ①-2 [보내기]를 빠르게 두 번 눌러도(같은 제출이 가는 중) 요청은 하나이고 두 번째는 busy다', async () => {
  const m = await modules();
  const { api } = server();
  let release;
  const gate = new Promise((r) => (release = r));
  api.on('POST', COMMANDS, async () => {
    await gate;
    return json(201, commandState({ type: 'ADMISSION_TARGET', state: 'DISPATCHED' }));
  });
  const a = m.createCommandActions({ role: 'operator', layout: 'desktop', reauth: dialog(m.requestReauth).fn });
  const sub = new m.Submission();
  const first = a.submit(targetDraft(), sub, { reauth: false });
  const second = await a.submit(targetDraft(), sub, { reauth: false });
  assert.deepEqual(second, { kind: 'busy' });
  release();
  assert.equal((await first).kind, 'done');
  assert.equal(commandPosts(api).length, 1);
});

test('F-03-4 T7 ①-3 실패한 제출을 같은 Submission으로 다시 보내면 같은 멱등 키, 값을 바꿔 새 Submission이면 새 키다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', COMMANDS, [() => problem(500, 'about:blank'), () => json(201, commandState({ type: 'ADMISSION_TARGET', state: 'DISPATCHED' }))]);
  const a = m.createCommandActions({ role: 'operator', layout: 'desktop', reauth: dialog(m.requestReauth).fn });
  const sub = new m.Submission();
  const failed = await a.submit(targetDraft(), sub, { reauth: false });
  assert.equal(failed.kind, 'problem');
  assert.equal(failed.message, '일시적인 오류입니다. 잠시 후 다시 시도해 주세요');
  assert.equal((await a.submit(targetDraft(), sub, { reauth: false })).kind, 'done');
  const next = new m.Submission();
  await a.submit(targetDraft({ target: 6000 }), next, { reauth: false });
  assert.deepEqual(
    commandPosts(api).map((p) => p.headers['idempotency-key']),
    [sub.idempotencyKey, sub.idempotencyKey, next.idempotencyKey],
  );
  assert.equal(commandPosts(api)[2].body.params.target, 6000);
});

test('F-03-4 T8 C-T46 ③-4 막힌 명령은 눌러도 요청·재인증이 0이다(operator의 명령 3·6, viewer의 dry-run, 휴대폰의 보내기)', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', COMMANDS, () => json(201, commandState()));
  api.on('POST', '/v1/ops/command-dry-runs', () => json(200, dryRunPgFallback()));
  const d = dialog(m.requestReauth);
  const operator = m.createCommandActions({ role: 'operator', layout: 'desktop', reauth: d.fn });
  assert.deepEqual(await operator.submit(killDraft(), new m.Submission(), { reauth: true }), { kind: 'blocked', reason: '판매 일시정지는 commander만 실행할 수 있습니다' });
  assert.equal((await operator.submit(pgDraft(), new m.Submission(), { reauth: true })).kind, 'blocked');
  const viewer = m.createCommandActions({ role: 'viewer', layout: 'desktop', reauth: d.fn });
  assert.equal((await viewer.dryRun(targetDraft())).kind, 'blocked');
  const phone = m.createCommandActions({ role: 'commander', layout: 'phone', reauth: d.fn });
  assert.deepEqual(await phone.submit(killDraft(), new m.Submission(), { reauth: true }), { kind: 'blocked', reason: '명령 요청과 실행은 태블릿이나 데스크톱에서 합니다' });
  assert.equal((await phone.dryRun(targetDraft())).kind, 'blocked');
  assert.deepEqual(d.calls, []);
  assert.equal(api.requests.length, 0);
});

test('F-03-4 T12 ①-1 사유가 비면 dry-run·보내기 모두 요청 없이 invalid이고 재인증도 띄우지 않는다', async () => {
  const m = await modules();
  const { api } = server();
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  assert.deepEqual(await a.submit(killDraft({ reason: '   ' }), new m.Submission(), { reauth: true }), { kind: 'invalid' });
  assert.deepEqual(await a.dryRun(targetDraft({ reason: '' })), { kind: 'invalid' });
  assert.deepEqual(d.calls, []);
  assert.equal(api.requests.length, 0);
});

test('F-03-4 T12 ①-2 dry-run은 재인증·멱등 키 없이 접수와 같은 본문으로 부르고 화면 줄을 돌려주며, 422는 걸린 한계 글로 끝난다', async () => {
  const m = await modules();
  const { dryRunView } = await import('./dry-run.ts');
  const { api } = server();
  api.on('POST', '/v1/ops/command-dry-runs', [() => json(200, dryRunPgFallback()), () => problem(422, 'command-out-of-range', { detail: 'admissionTargetMax' })]);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: dialog(m.requestReauth).fn });
  const ok = await a.dryRun(pgDraft());
  assert.deepEqual(ok, { kind: 'ok', view: dryRunView(dryRunPgFallback()) });
  const runs = api.sent('POST', '/v1/ops/command-dry-runs');
  assert.deepStrictEqual(runs[0].body, m.commandBodyOf(pgDraft()));
  assert.equal(Object.hasOwn(runs[0].headers, 'x-reauth-token'), false);
  assert.equal(Object.hasOwn(runs[0].headers, 'idempotency-key'), false);
  const bad = await a.dryRun(targetDraft({ target: 9000 }));
  assert.equal(bad.kind, 'problem');
  assert.equal(bad.status, 422);
  assert.equal(bad.type, 'command-out-of-range');
  assert.match(bad.message, /admissionTargetMax/);
  assert.equal(api.sent('POST', REAUTH).length, 0);
});

test('F-03-4 T12 ①-3 명령 6은 commander가 재인증해 요청하면 승인 대기(PENDING_APPROVAL)로 끝난다', async () => {
  const m = await modules();
  const { api, issued } = server();
  api.on('POST', COMMANDS, () =>
    json(201, commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', approvalExpiresAt: '2026-11-23T11:10:00.000Z', params: m.commandBodyOf(pgDraft()).params, delivery: null, dryRun: dryRunPgFallback() })),
  );
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'tablet', reauth: d.fn });
  const out = await a.submit(pgDraft(), new m.Submission(), { reauth: true });
  assert.equal(out.kind, 'done');
  assert.equal(out.command.state, 'PENDING_APPROVAL');
  assert.equal(commandPosts(api)[0].headers['x-reauth-token'], issued[0]);
  assert.deepStrictEqual(commandPosts(api)[0].body.params, { mode: 'PAYMENT_PG_FALLBACK', scope: 'EVENT', eventIds: [E], toPg: 'PORTONE' });
});

test('F-03-4 T9 C-T4 ②-2 승인은 재인증(OPS_COMMAND) 뒤 X-Reauth-Token을 실어 부른다(PENDING_APPROVAL·REVERT_PENDING 모두, 휴대폰도)', async () => {
  const m = await modules();
  const { api, issued } = server();
  api.on('POST', `${COMMANDS}/${C1}/approvals`, () => json(200, commandState({ type: 'DEGRADED_MODE', state: 'DISPATCHED' })));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'operator', layout: 'phone', reauth: d.fn });
  const pending = commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', approvalExpiresAt: '2026-11-23T11:10:00.000Z', canApprove: true, dryRun: dryRunPgFallback() });
  const out = await a.approve(pending);
  assert.equal(out.kind, 'done');
  const revertPending = commandState({ state: 'REVERT_PENDING', approvalExpiresAt: '2026-11-23T11:20:00.000Z', canApprove: true });
  assert.equal((await a.approve(revertPending)).kind, 'done');
  assert.deepEqual(d.calls, ['OPS_COMMAND', 'OPS_COMMAND']);
  const approvals = api.sent('POST', `${COMMANDS}/${C1}/approvals`);
  assert.equal(approvals.length, 2);
  assert.deepEqual(
    approvals.map((r) => r.headers['x-reauth-token']),
    [issued[0], issued[1]],
  );
  assert.deepEqual(
    api.sent('POST', REAUTH).map((r) => r.body.act),
    ['OPS_COMMAND', 'OPS_COMMAND'],
  );
});

test('F-03-4 T9 C-T4 ②-3 요청자 본인(canApprove: false)은 승인을 막아 재인증·요청이 0이고, 서버 403이면 요청자 글이다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', `${COMMANDS}/${C1}/approvals`, () => problem(403, 'command-requester-cannot-approve'));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  const mine = commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', approvalExpiresAt: '2026-11-23T11:10:00.000Z', canApprove: false });
  assert.deepEqual(await a.approve(mine), { kind: 'blocked', reason: '요청자 본인은 승인할 수 없습니다' });
  assert.deepEqual(d.calls, []);
  assert.equal(api.requests.length, 0);
  // 화면 값이 낡아 canApprove가 참이었어도 서버가 막으면 같은 글이다
  const stale = await a.approve({ ...mine, canApprove: true });
  assert.equal(stale.kind, 'problem');
  assert.equal(stale.message, '요청자 본인은 승인할 수 없습니다');
});

test('F-03-4 T9 C-T4 ②-4 반려는 사유를 본문에만 싣고 재인증 없이 부르며, 사유가 비면 보내지 않는다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', `${COMMANDS}/${C1}/rejections`, () => json(200, commandState({ type: 'DEGRADED_MODE', state: 'REJECTED' })));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'operator', layout: 'phone', reauth: d.fn });
  const pending = commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', canApprove: true });
  assert.deepEqual(await a.reject(pending, '  '), { kind: 'invalid' });
  assert.equal((await a.reject(pending, ' 결제사가 정상으로 돌아왔습니다 ')).kind, 'done');
  const sent = api.sent('POST', `${COMMANDS}/${C1}/rejections`);
  assert.equal(sent.length, 1);
  assert.deepStrictEqual(sent[0].body, { reason: '결제사가 정상으로 돌아왔습니다' });
  assert.deepEqual(sent[0].query, {});
  assert.equal(Object.hasOwn(sent[0].headers, 'x-reauth-token'), false);
  assert.deepEqual(d.calls, []);
});

test('F-03-4 T10 C-T7 ②-5 실패한 위험 명령의 다시 시도는 재인증 뒤 토큰을 싣고, 위험하지 않은 명령은 재인증 없이 보낸다', async () => {
  const m = await modules();
  const { api, issued } = server();
  api.on('POST', `${COMMANDS}/${C1}/retries`, () => json(200, commandState({ state: 'DISPATCHED' })));
  const d = dialog(m.requestReauth);
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  assert.equal((await a.retry(commandState({ state: 'FAILED', lastError: 'purchase-svc-3 ack 시간 초과' }))).kind, 'done');
  assert.equal((await a.retry(commandState({ type: 'ADMISSION_TARGET', state: 'FAILED', dryRun: { ...commandState().dryRun, approvalMode: 'ONE', reauthRequired: false } }))).kind, 'done');
  const sent = api.sent('POST', `${COMMANDS}/${C1}/retries`);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers['x-reauth-token'], issued[0]);
  assert.equal(Object.hasOwn(sent[1].headers, 'x-reauth-token'), false);
  assert.deepEqual(d.calls, ['OPS_COMMAND']);
});

test('F-03-4 T12 C-T46 ④-1 되돌리기: 명령 1은 재인증 없이, 명령 3은 commander 재인증 뒤 202 REVERT_PENDING, 명령 6은 commander 재인증이다', async () => {
  const m = await modules();
  const { api, issued } = server();
  api.on('POST', `${COMMANDS}/${C1}/reversions`, [
    () => json(200, commandState({ type: 'ADMISSION_TARGET', state: 'REVERTED' })),
    () => json(202, commandState({ state: 'REVERT_PENDING', approvalExpiresAt: '2026-11-23T11:20:00.000Z' })),
    () => json(200, commandState({ type: 'DEGRADED_MODE', state: 'REVERTED' })),
  ]);
  const d = dialog(m.requestReauth);
  const operator = m.createCommandActions({ role: 'operator', layout: 'desktop', reauth: d.fn });
  const commander = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  const r1 = await operator.revert(commandState({ type: 'ADMISSION_TARGET', state: 'ACKED' }), '자동 조절로 돌아갑니다');
  assert.equal(r1.kind, 'done');
  assert.deepEqual(d.calls, []);
  const r3 = await commander.revert(commandState({ state: 'ACKED' }), '결제사 승인 응답이 정상으로 돌아왔습니다');
  assert.equal(r3.kind, 'done');
  assert.equal(r3.status, 202);
  assert.equal(r3.command.state, 'REVERT_PENDING');
  const r6 = await commander.revert(commandState({ type: 'DEGRADED_MODE', state: 'ACKED' }), 'Degraded 모두 해제');
  assert.equal(r6.kind, 'done');
  const sent = api.sent('POST', `${COMMANDS}/${C1}/reversions`);
  assert.deepEqual(
    sent.map((r) => r.headers['x-reauth-token'] ?? null),
    [null, issued[0], issued[1]],
  );
  assert.deepStrictEqual(
    sent.map((r) => r.body),
    [{ reason: '자동 조절로 돌아갑니다' }, { reason: '결제사 승인 응답이 정상으로 돌아왔습니다' }, { reason: 'Degraded 모두 해제' }],
  );
  assert.deepEqual(d.calls, ['OPS_COMMAND', 'OPS_COMMAND']);
});

test('F-03-4 T12 C-T46 ④-2 명령 3·6 되돌리기는 operator면 막히고, 사유가 비면 보내지 않는다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', `${COMMANDS}/${C1}/reversions`, () => json(202, commandState({ state: 'REVERT_PENDING' })));
  const d = dialog(m.requestReauth);
  const operator = m.createCommandActions({ role: 'operator', layout: 'desktop', reauth: d.fn });
  assert.equal((await operator.revert(commandState({ state: 'ACKED' }), '판매 재개')).kind, 'blocked');
  assert.equal((await operator.revert(commandState({ type: 'DEGRADED_MODE', state: 'ACKED' }), '해제')).kind, 'blocked');
  const commander = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
  assert.deepEqual(await commander.revert(commandState({ state: 'ACKED' }), ''), { kind: 'invalid' });
  assert.deepEqual(d.calls, []);
  assert.equal(api.requests.length, 0);
});

test('F-03-4 T5 [ASVS v5.0.0-3.3.4] 재인증·보내기·승인·되돌리기 뒤 쿠키·localStorage·sessionStorage에 쓴 것이 없고, 토큰은 X-Reauth-Token 머리로만, 비밀번호·코드는 재인증 본문으로만 나간다', async () => {
  const m = await modules();
  const store = recordStorage();
  try {
    const { api, issued } = server();
    api.on('POST', COMMANDS, () => json(201, commandState({ state: 'DISPATCHED' })));
    api.on('POST', `${COMMANDS}/${C1}/approvals`, () => json(200, commandState({ type: 'DEGRADED_MODE', state: 'DISPATCHED' })));
    api.on('POST', `${COMMANDS}/${C1}/reversions`, () => json(202, commandState({ state: 'REVERT_PENDING' })));
    const d = dialog(m.requestReauth);
    const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: d.fn });
    await a.submit(killDraft(), new m.Submission(), { reauth: true });
    await a.approve(commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', canApprove: true }));
    await a.revert(commandState({ state: 'ACKED' }), '판매 재개');
    assert.equal(issued.length, 3);
    assert.deepEqual(store.writes, []);
    for (const r of api.requests) {
      const outside = JSON.stringify({ url: r.url, query: r.query, body: r.body ?? null, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== 'x-reauth-token')) });
      for (const t of issued) assert.equal(outside.includes(t), false, `${r.method} ${r.path}에 토큰이 머리 밖으로 나갔다`);
      if (r.path !== REAUTH) {
        assert.equal(outside.includes(PW), false, `${r.path}에 비밀번호`);
        assert.equal(outside.includes(CODE), false, `${r.path}에 인증 코드`);
      }
    }
    // 토큰 하나는 요청 하나에만(jti 한 번)
    for (const t of issued) assert.equal(api.requests.filter((r) => r.headers['x-reauth-token'] === t).length, 1);
  } finally {
    store.restore();
  }
});

test('F-03-4 T6 [ASVS v5.0.0-14.2.1] 명령 요청 주소에는 명령 ID만 있고 쿼리가 없으며, 사유·매개변수는 본문이다. 명령 화면 원본은 주소 쿼리를 바꾸지 않는다', async () => {
  const m = await modules();
  const { api } = server();
  api.on('POST', '/v1/ops/command-dry-runs', () => json(200, dryRunPgFallback()));
  api.on('POST', COMMANDS, () => json(201, commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL' })));
  for (const tail of ['approvals', 'rejections', 'retries', 'reversions']) api.on('POST', `${COMMANDS}/${C1}/${tail}`, () => json(200, commandState({ state: 'DISPATCHED' })));
  const a = m.createCommandActions({ role: 'commander', layout: 'desktop', reauth: dialog(m.requestReauth).fn });
  await a.dryRun(pgDraft());
  await a.submit(pgDraft(), new m.Submission(), { reauth: true });
  await a.approve(commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', canApprove: true }));
  await a.reject(commandState({ type: 'DEGRADED_MODE', state: 'PENDING_APPROVAL', canApprove: true }), '반려 사유');
  await a.retry(commandState({ state: 'FAILED' }));
  await a.revert(commandState({ type: 'DEGRADED_MODE', state: 'ACKED' }), '되돌림 사유');
  const ops = api.requests.filter((r) => r.path !== REAUTH);
  assert.equal(ops.length, 6);
  for (const r of ops) {
    assert.match(r.path, new RegExp(`^/v1/ops/(command-dry-runs|commands(/${C1}/(approvals|rejections|retries|reversions))?)$`), r.path);
    assert.deepEqual(r.query, {}, r.path);
    for (const secret of ['토스 승인 지연', '반려 사유', '되돌림 사유', 'PAYMENT_PG_FALLBACK', 'PORTONE']) assert.equal(r.url.includes(encodeURIComponent(secret)) || r.url.includes(secret), false, `${r.path} 주소에 ${secret}`);
  }
  assert.equal(ops[0].body.reason, pgDraft().reason);
  assert.equal(ops[1].body.params.toPg, 'PORTONE');
  // 화면 원본(명령 화면·부품·모델)은 주소 쿼리를 쓰지 않는다(?event= 말고 바뀌지 않는다)
  const dir = new URL('../ui/connected/', import.meta.url);
  assert.ok(existsSync(dir), 'ui/connected/ 부품 폴더가 없다');
  const files = [new URL('../ui/ConnectedPage.tsx', import.meta.url), new URL('./command-actions.ts', import.meta.url), ...readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => new URL(f, dir))];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /setSearchParams\s*\(|history\.(?:pushState|replaceState)\s*\(|location\.(?:search|hash)\s*=/, f.pathname);
  }
});
