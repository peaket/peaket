// 관제 재인증을 명령용 동작(act OPS_COMMAND)으로 넓힌다(F-03-4 T4·T5, C-T5, 시험 먼저 ADR 0372번).
// 정본: docs/api/openapi.yaml OpsReauthPasswordStep(act OPS_COMMAND|APPROVAL|…, withPasskey), AdminReauthDone(factors),
// docs/features/control-tower.md §3 '위험 명령 재인증의 첫 구현'(act=OPS_COMMAND, factors에 passkey), docs/design/d5-screen-blueprint.md §7.3 명령 3 ④ 재인증 칸 글,
// 계획 docs/review/plans/F-03-4.md §4 features/admin-reauth(requestReauth·ReauthDialog act·description).
// 기존 api.test.mjs(BAT-421)를 깨지 않게 파일을 나눴다. 구현 전 트리에는 requestReauth가 없고, 대화상자 글이 '회차 취소 확정'으로 고정이라 실패한다.
// 가짜는 REST 경계(전역 fetch)만 쓴다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeRest, json } from '../../pages/commands/model/commands.test.fakes.mjs';

register('../../pages/dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

const REAUTH = '/v1/ops/auth/reauthentications';
const D5_REAUTH_LINE = '실행 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다(5분 재인증 토큰).';

test('F-03-4 T4 C-T5 ①-1 requestReauth는 act OPS_COMMAND·withPasskey로 부르고 패스키까지 확인한 토큰을 돌려준다', async () => {
  const api = fakeRest();
  api.on('POST', REAUTH, () => json(200, { next: 'DONE', reauthToken: 'tok-ops-1', factors: ['password', 'totp', 'passkey'], expiresInSeconds: 300 }));
  api.install();
  const { requestReauth } = await import('./api.ts');
  assert.equal(typeof requestReauth, 'function', 'api.ts에 requestReauth가 없다');
  const token = await requestReauth({ act: 'OPS_COMMAND', password: 'pw-Δ-secret', code: '123 456' });
  assert.equal(token, 'tok-ops-1');
  const sent = api.sent('POST', REAUTH);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { act: 'OPS_COMMAND', password: 'pw-Δ-secret', code: '123 456', withPasskey: true });
  // 주소에는 비밀번호·코드가 없다
  assert.deepEqual(sent[0].query, {});
});

test('F-03-4 T4 C-T5 ①-2 factors에 passkey가 없는 OPS_COMMAND 토큰은 서버가 200을 줘도 쓰지 않는다', async () => {
  const api = fakeRest();
  api.on('POST', REAUTH, () => json(200, { next: 'DONE', reauthToken: 'tok-no-passkey', factors: ['password', 'totp'], expiresInSeconds: 300 }));
  api.install();
  const { requestReauth } = await import('./api.ts');
  assert.equal(typeof requestReauth, 'function', 'api.ts에 requestReauth가 없다');
  await assert.rejects(requestReauth({ act: 'OPS_COMMAND', password: 'pw', code: '123456' }), /패스키/);
});

test('F-03-4 T4 C-T5 ①-3 회차 취소·정산의 승인 재인증은 그대로 act APPROVAL이다', async () => {
  const api = fakeRest();
  api.on('POST', REAUTH, () => json(200, { next: 'DONE', reauthToken: 'tok-approval', factors: ['password', 'totp', 'passkey'], expiresInSeconds: 300 }));
  api.install();
  const { requestApprovalReauth, requestReauth } = await import('./api.ts');
  assert.equal(typeof requestReauth, 'function', 'api.ts에 requestReauth가 없다');
  assert.equal(await requestApprovalReauth({ password: 'pw', code: '123456' }), 'tok-approval');
  assert.equal(api.sent('POST', REAUTH)[0].body.act, 'APPROVAL');
});

test('F-03-4 T4 C-T5 ①-4 재인증 대화상자는 부르는 쪽이 넘긴 설명을 보이고 회차 취소 글을 고정으로 보이지 않는다', async () => {
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { ReauthDialog } = await import('./ReauthDialog.tsx');
  const html = renderToString(createElement(ReauthDialog, { open: true, act: 'OPS_COMMAND', description: D5_REAUTH_LINE, onDone: () => undefined, onClose: () => undefined }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
  assert.ok(text.includes(D5_REAUTH_LINE), `설명 글이 없다: ${text.slice(0, 300)}`);
  assert.equal(text.includes('회차 취소 확정'), false);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  // 비밀번호 칸은 저장하지 않는 입력(type=password)이다
  assert.match(html, /type="password"/);
});
