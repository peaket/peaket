// SCR-017 계정 설정의 상태 → 화면 조각, 그리고 겹침 창 흐름(SettingsFlows)의 연결 시험(d5 §5.17, docs/features/identity.md §8 '탈퇴 화면 연결').
// 화면 부품(.tsx)은 node로 그리지 못해, 흐름 규칙은 features/account-withdraw 흐름 시험이 보고 여기서는 화면이 그 규칙을 쓰는지 소스로 본다
// (entities/appeal/fraud.test.mjs의 화면 연결 시험과 같은 방법). state.ts·screens.account.ts는 타입 import만 써서 타입 지우기로 바로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCR017_STATES } from '../../../shared/config/screens.account.ts';
import { settingsView } from './state.ts';

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
