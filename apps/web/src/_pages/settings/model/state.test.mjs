// SCR-017 계정 설정의 상태 → 화면 조각, 그리고 겹침 창 흐름(SettingsFlows)의 연결 시험(d5 §5.17, docs/features/identity.md §8 '탈퇴 화면 연결').
// 화면 부품(.tsx)은 node로 그리지 못해, 흐름 규칙은 features/account-withdraw 흐름 시험이 보고 여기서는 화면이 그 규칙을 쓰는지 소스로 본다
// (entities/appeal/fraud.test.mjs의 화면 연결 시험과 같은 방법). state.ts·screens.account.ts는 타입 import만 써서 타입 지우기로 바로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCR017_STATES } from '../../../shared/config/screens.account.ts';
import { settingsView } from './state.ts';
import { returnOnMount, resumeDeviceLogout } from './devices.ts';
import { markPending as markDevicePending } from '../../../features/device-sessions/flow.ts';
import { markPending as markWithdrawPending } from '../../../features/account-withdraw/flow.ts';

const PAGE = readFileSync(new URL('../ui/SettingsPage.tsx', import.meta.url), 'utf8');
const FLOWS = readFileSync(new URL('../ui/SettingsFlows.tsx', import.meta.url), 'utf8');

test("SCR-017 미리보기에 '본인확인 전' 상태가 있고, 그 상태만 본인확인 전 계정으로 그린다(d5 §5.17 ①, BOT-020이 넘긴 것)", () => {
  assert.ok(SCR017_STATES.includes('본인확인 전'));
  assert.equal(settingsView('본인확인 전').verified, false);
  for (const st of SCR017_STATES.filter((x) => x !== '본인확인 전')) assert.equal(settingsView(st).verified, true, st);
  // 휴대폰 본인확인 칸과 데스크톱 왼쪽 배지가 모두 보기 값의 본인확인 여부를 쓴다(목업 ME만 보지 않는다)
  assert.match(PAGE, /<VerifySection verified=\{verified\} \/>/);
  assert.match(PAGE, /<SideMenu verified=\{verified\} \/>/);
});

test('SCR-017 미리보기 상태를 고르면(클라이언트 이동) 겹침 창 흐름의 상태를 새로 시작한다: SettingsFlows에 key={state}(BOT-036이 넘긴 것)', () => {
  assert.match(PAGE, /<SettingsFlows\s+key=\{state\}/);
});

test('탈퇴 재인증 버튼은 떠나기 흐름(leaveForReauth)을 쓰고, 갱신을 기다리는 동안 처리 중(aria-disabled·aria-busy)이며 창을 닫으면 떠나기를 취소한다(BOT-036이 넘긴 것)', () => {
  assert.match(FLOWS, /leaveForReauth\(/);
  // 실제 탈퇴는 제공자를 몰라도 실제 재인증으로 간다(목업 갈래로 빠지는 '&& via' 조건이 없다)
  assert.doesNotMatch(FLOWS, /purpose\.kind === 'withdraw' && via/);
  // 재인증 창의 다시 로그인 버튼(하나·여럿 모두)
  const buttons = FLOWS.match(/로 다시 로그인하고 계속/g) ?? [];
  assert.equal(buttons.length, 2);
  assert.equal((FLOWS.match(/aria-disabled=\{leaving \|\| undefined\}/g) ?? []).length, 2);
  assert.equal((FLOWS.match(/aria-busy=\{leaving \|\| undefined\}/g) ?? []).length, 2);
  // 닫기는 진행 중인 떠나기를 취소한다
  assert.match(FLOWS.match(/const close = \(\) => \{([\s\S]*?)\n  \};/)?.[1] ?? '', /leaveRef\.current\?\.cancel\(\);/);
});

test('재인증에서 돌아왔는데 결과 응답에 제공자가 없으면 로그인 수단 목록으로 조용히 채운다: 확인 창이 열린 동안에는 실패해도 떠나지 않고 안내도 띄우지 않는다(BOT-036이 넘긴 것, 새 맥락 리뷰)', () => {
  assert.match(FLOWS, /if \(r\.provider\) setLiveProvider\(r\.provider\);\s*\n\s*else void fillProviderQuietly\(\);/);
  // 조용한 채우기는 linkedProvidersQuietly만 쓰고 로그인 화면(toLogin)·안내(sorry)를 부르지 않는다(동작은 account-withdraw 흐름 시험이 본다)
  const body = FLOWS.match(/const fillProviderQuietly = async \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(body, 'fillProviderQuietly가 없다');
  assert.match(body[1], /linkedProvidersQuietly\(api!?\)/);
  assert.doesNotMatch(body[1], /toLogin|sorry/);
  // 제공자를 모르면 확인 창 위 줄은 제공자 이름 없이 '다시 로그인했습니다'
  assert.match(FLOWS, /provider \? `\$\{provider\}로 다시 로그인했습니다` : '다시 로그인했습니다'/);
});

test('창을 닫으면 메모리의 재인증 토큰과 보관 안내 상태를 지운다: 다시 열면 재인증부터 한다(identity §8, 새 맥락 재검토)', () => {
  const body = FLOWS.match(/const close = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(body, 'close가 없다');
  assert.match(body[1], /setToken\(null\);/);
  assert.match(body[1], /setLiveHold\(null\);/);
});

test('탈퇴 확인 창의 확정은 닫힘을 세어 늦게 온 응답을 afterWithdraw로 가른다(닫은 뒤의 보관 안내·재인증 창을 다시 열지 않는다, 새 맥락 마지막 검토)', () => {
  assert.match(FLOWS, /closedRef\.current \+= 1;/);
  assert.match(FLOWS, /afterWithdraw\(r, \{ closed: opened !== closedRef\.current \}\)/);
});

const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};
const TARGET = { sessionId: '0190f3a1-7c2e-7a00-8000-0000000000b1', name: 'Safari · iPhone', scope: 'device', at: 1000 };

test('I-T74_재인증에서돌아오면원격로그아웃·탈퇴표시를둘다지우고_나중에남긴쪽만잇는다(새맥락리뷰낮음7)', () => {
  const s = memoryStore();
  markDevicePending(s, TARGET);
  markWithdrawPending(s, 900);
  assert.deepEqual(returnOnMount(s, 2000, { devices: true, withdraw: true }), { kind: 'device', pending: TARGET });
  assert.equal(s.m.size, 0);
  markDevicePending(s, TARGET);
  markWithdrawPending(s, 1500);
  assert.deepEqual(returnOnMount(s, 2000, { devices: true, withdraw: true }), { kind: 'withdraw' });
  assert.equal(s.m.size, 0);
  assert.equal(returnOnMount(s, 2000, { devices: true, withdraw: true }), null);
  // 목업 흐름(실제 API 없음)이면 표시를 건드리지 않는다
  markDevicePending(s, TARGET);
  assert.equal(returnOnMount(s, 2000, { devices: false, withdraw: false }), null);
  assert.equal(s.m.size, 1);
});

test('I-T74_돌아와받은재인증토큰으로그기기를끄고결과를고른다_토큰을못받거나403이면그기기의재인증창_401뒤갱신도401이면로그인(새맥락리뷰낮음7) [ASVS v5.0.0-7.5.2]', async () => {
  const calls = [];
  const run = (pickup, end) => resumeDeviceLogout({ pending: TARGET, pickup: async () => pickup, end: async (id, tok) => (calls.push([id, tok]), end) });
  assert.deepEqual(await run({ kind: 'token', token: 'tok-1' }, { kind: 'done' }), { kind: 'toast', text: 'Safari · iPhone에서 로그아웃했습니다', icon: 'ic-check' });
  assert.deepEqual(calls, [[TARGET.sessionId, 'tok-1']]);
  assert.deepEqual(await run({ kind: 'token', token: 't' }, { kind: 'gone' }), { kind: 'toast', text: '이미 로그아웃된 기기입니다', icon: 'ic-info' });
  assert.deepEqual(await run({ kind: 'token', token: 't' }, { kind: 'error' }), { kind: 'toast', text: '지금은 로그아웃할 수 없습니다. 잠시 뒤 다시 시도해 주세요', icon: 'ic-alert-circle' });
  assert.deepEqual(await run({ kind: 'token', token: 't' }, { kind: 'login' }), { kind: 'login' });
  assert.deepEqual(await run({ kind: 'token', token: 't' }, { kind: 'reauth' }), { kind: 'reauth-failed', text: '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요', target: TARGET });
  const before = calls.length;
  assert.deepEqual(await run({ kind: 'failed', reason: 'stale' }, { kind: 'done' }), { kind: 'reauth-failed', text: '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요', target: TARGET });
  assert.equal(calls.length, before, '토큰이 없으면 끄지 않는다');
  // 지금 기기의 다른 로그인 끝내기는 문구가 다르다
  assert.deepEqual(await resumeDeviceLogout({ pending: { ...TARGET, scope: 'others' }, pickup: async () => ({ kind: 'token', token: 't' }), end: async () => ({ kind: 'done' }) }), {
    kind: 'toast',
    text: '이 기기의 다른 로그인을 끝냈습니다',
    icon: 'ic-check',
  });
});

test('I-T74_설정화면은돌아오기·원격로그아웃을위모델로잇고_지금이기기줄에다른로그인이있을때만[이기기의다른로그인끝내기]를보인다(BOT-044, d5 §5.17)', () => {
  assert.match(FLOWS, /returnOnMount\(tabStore, /);
  assert.match(FLOWS, /resumeDeviceLogout\(\{/);
  assert.match(FLOWS, /leaveForDeviceReauth\(/);
  assert.match(FLOWS, /otherLoginsOf\(liveRows\)/);
  assert.match(FLOWS, /이 기기의 다른 로그인 끝내기/);
  assert.match(FLOWS, /로그인한 기기를 불러오지 못했습니다/);
  // 실제 흐름에는 현장 스캐너 안내 띠가 없다(스캐너 세션은 이 API에 없다, BUILD_ORDER GAT-230)
  assert.match(PAGE, /live \? null : \(\s*<div className="banner banner-info"/);
});
