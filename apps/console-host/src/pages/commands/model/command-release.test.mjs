// 명령 6 해제 갈래(PAYMENT_ENTRY_RELEASE: 결제사 장애로 payment-svc가 스스로 건 새 결제 진입 정지를 연다)의 본문·막힘·보내기·카드(F-03-4 T12 ③, 시험 먼저 ADR 0372번).
// 다시 쌓은 트리(F-02-2 포함)의 openapi에 칸이 생겨 더한 시험이다.
// 정본: docs/api/openapi.yaml Command.params 설명 'DEGRADED_MODE의 해제 갈래 {mode: PAYMENT_ENTRY_RELEASE, pg: TOSS|PORTONE|SIMULATOR(local·ci만)}
// (commander만 요청하고 승인 대기 없이 재인증 뒤 바로 보낸다 … operator는 403, 되돌리기는 409 command-not-revertible, ADR-0366 결정 8)',
// docs/features/control-tower.md §3 명령 6 행 되돌리기 칸(commander 1인이 사유를 적고 재인증해 실행), §12 휴대폰, 계획 docs/review/plans/F-03-4.md 1-6·§4 CommandDraft.
// 시험이 정한 공개 인터페이스: CommandDraft { kind: 'PG_ENTRY_RELEASE', pg: 'TOSS' | 'PORTONE' | 'SIMULATOR', reason }.
// 가짜는 REST 경계(전역 fetch)만 쓴다.
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, commandState, fakeRest, json, reauthServer } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';
globalThis.__SCANNER_ORIGIN__ = 'https://scanner.test';
globalThis.__CONSOLE_BUILD__ = 'mf';

const OPENAPI = readFileSync(new URL('../../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
const release = (over = {}) => ({ kind: 'PG_ENTRY_RELEASE', pg: 'TOSS', reason: '토스 승인 응답이 정상으로 돌아와 새 결제를 엽니다', ...over });
const releaseState = (over = {}) =>
  commandState({ type: 'DEGRADED_MODE', state: 'DISPATCHED', params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'TOSS' }, dryRun: { version: 1, approvalMode: 'NONE', reauthRequired: true, counted: [], predicted: [], unavailable: [], limits: {} }, ...over });

test('F-03-4 T12 ③-1 해제 본문은 openapi 해제 갈래 칸(mode·pg)만 싣고, pg가 없거나 사유가 비면 null이다', async () => {
  const { commandBodyOf } = await import('./command-form.ts');
  assert.ok(OPENAPI.includes('DEGRADED_MODE의 해제 갈래 {mode: PAYMENT_ENTRY_RELEASE, pg: TOSS|PORTONE|SIMULATOR'), 'openapi 해제 갈래 칸 설명이 바뀌었다');
  assert.deepStrictEqual(commandBodyOf(release()), { type: 'DEGRADED_MODE', reason: '토스 승인 응답이 정상으로 돌아와 새 결제를 엽니다', params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'TOSS' } });
  assert.deepStrictEqual(commandBodyOf(release({ pg: 'PORTONE', reason: '  포트원 정상  ' })), { type: 'DEGRADED_MODE', reason: '포트원 정상', params: { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'PORTONE' } });
  assert.equal(commandBodyOf(release({ pg: undefined })), null);
  assert.equal(commandBodyOf(release({ reason: ' ' })), null);
});

test('F-03-4 T12 ③-2 해제는 commander만 요청할 수 있고(operator·viewer는 까닭 글), 휴대폰은 commander도 막는다', async () => {
  const { commandAvailability } = await import('./command-form.ts');
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'desktop', kind: 'PG_ENTRY_RELEASE' }), { canRequest: true });
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'tablet', kind: 'PG_ENTRY_RELEASE' }), { canRequest: true });
  for (const role of ['operator', 'viewer']) {
    const a = commandAvailability({ role, layout: 'desktop', kind: 'PG_ENTRY_RELEASE' });
    assert.equal(a.canRequest, false, role);
    assert.match(a.reason, /commander만/, role);
  }
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'phone', kind: 'PG_ENTRY_RELEASE' }), { canRequest: false, reason: '명령 요청과 실행은 태블릿이나 데스크톱에서 합니다' });
});

test('F-03-4 T12 ③-3 commander의 해제는 재인증(OPS_COMMAND) 토큰을 실어 접수하고 승인 대기 없이 끝나며, operator는 요청·재인증 0이다', async () => {
  const api = fakeRest();
  const issued = reauthServer(api);
  api.on('POST', '/v1/ops/commands', () => json(201, releaseState()));
  api.install();
  const { createCommandActions } = await import('./command-actions.ts');
  const { Submission } = await import('./command-form.ts');
  const { requestReauth } = await import('../../../features/admin-reauth/api.ts');
  const prompts = [];
  const reauth = async (act) => {
    prompts.push(act);
    return requestReauth({ act, password: 'pw', code: '123456' });
  };
  const operator = createCommandActions({ role: 'operator', layout: 'desktop', reauth });
  assert.equal((await operator.submit(release(), new Submission(), { reauth: true })).kind, 'blocked');
  assert.equal(api.requests.length, 0);
  const commander = createCommandActions({ role: 'commander', layout: 'desktop', reauth });
  const sub = new Submission();
  const out = await commander.submit(release(), sub, { reauth: true });
  assert.equal(out.kind, 'done');
  assert.equal(out.command.state, 'DISPATCHED');
  const posts = api.sent('POST', '/v1/ops/commands');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['x-reauth-token'], issued[0]);
  assert.equal(posts[0].headers['idempotency-key'], sub.idempotencyKey);
  assert.deepStrictEqual(posts[0].body.params, { mode: 'PAYMENT_ENTRY_RELEASE', pg: 'TOSS' });
  assert.deepEqual(prompts, ['OPS_COMMAND']);
});

test('F-03-4 T12 ③-4 해제를 ACKED로 마친 카드에는 되돌리기 단추가 없다(되돌리기는 409 command-not-revertible)', async () => {
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router');
  const { CommandCard } = await import('../ui/connected/CommandCard.tsx');
  const { commandCardState } = await import('./card-state.ts');
  const d = releaseState({ state: 'ACKED', delivery: { kind: 'ACK', ackedCount: 2, targetCount: 2, unackedTargets: [] } });
  const noop = () => undefined;
  const html = renderToString(
    createElement(MemoryRouter, { initialEntries: [`/commands?event=${E}`] }, createElement(CommandCard, { detail: d, state: commandCardState(d, { nowMs: Date.parse('2026-11-23T11:01:00.000Z') }), role: 'commander', onApprove: noop, onReject: noop, onRetry: noop, onRevert: noop })),
  );
  const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  assert.equal(
    labels.some((t) => /되돌리|해제|재개/.test(t)),
    false,
    `해제 명령에 되돌리기 단추: ${labels.join(' | ')}`,
  );
});

test('F-03-4 T12 ③-5 commander 데스크톱 카탈로그의 명령 6 카드에는 새 결제 진입 정지를 여는 단추가 있고, operator에게는 살아 있는 단추가 아니다', async () => {
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { MemoryRouter } = await import('react-router');
  const { CommandCatalog } = await import('../ui/connected/CommandCatalog.tsx');
  const noop = () => undefined;
  const draw = (role) => renderToString(createElement(MemoryRouter, { initialEntries: [`/commands?event=${E}`] }, createElement(CommandCatalog, { role, layout: 'desktop', onPick: noop })));
  const find = (html) =>
    [...html.matchAll(/<button(\s[^>]*)?>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1] ?? '', text: m[2].replace(/<[^>]+>/g, '') })).filter((b) => b.text.includes('진입 정지'));
  const mine = find(draw('commander'));
  assert.equal(mine.length, 1, '새 결제 진입 정지를 여는 단추가 하나 있어야 한다');
  assert.doesNotMatch(mine[0].attrs, /aria-disabled="true"|\sdisabled/);
  for (const b of find(draw('operator'))) assert.match(b.attrs, /aria-disabled="true"/, 'operator에게 살아 있는 해제 단추');
});
