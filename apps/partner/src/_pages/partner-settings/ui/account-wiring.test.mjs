// F-07-13 SCR-020 '내 계정' 실제 판의 배선 시험(계획 §4·§6, d5 §6.1 ⑦, ASVS 6.4.4·7.5.1·7.5.2).
// 실제 판 파일 자리는 계획 §4의 `ui/live/AccountSecurityLive.tsx`다. 미리보기(`?state=`)는 기존 목업을 그대로 그린다.
// 이 시험은 소스 글자를 보는 정적 검사다. 브라우저 동작은 구현 리뷰·브라우저 확인 몫이고 이번 턴에는 누르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const livePath = new URL('./live/AccountSecurityLive.tsx', import.meta.url);
const live = existsSync(livePath) ? readFileSync(livePath, 'utf8') : '';
const page = read('./AccountPage.tsx');
const api = read('../../../shared/api/partner-live.ts');

const needLive = () => assert.ok(live.length > 0, 'partner-settings/ui/live/AccountSecurityLive.tsx가 없다');

test('I-T53 ③ SCR-020 내 계정은 ?state=가 없으면 실제 보안 줄을 그리고 미리보기는 기존 목업을 그린다', () => {
  assert.match(page, /from '\.\/live\/AccountSecurityLive'/);
  assert.match(page, /<AccountSecurityLive\b/);
  assert.match(page, /accountPageMode\(/);
  assert.match(page, /===\s*'live'|==\s*'live'/);
  // 미리보기 쪽은 기존 목업을 그대로 쓴다
  assert.match(page, /\baccountSecurity\b|loginDevices/);
  assert.match(page, /ACCOUNT_STATES|PreviewStateSwitcher/);
});

test('I-T53 ③ 실제 보안 줄은 partner-live의 여섯 함수만 부르고 fetch를 직접 만들지 않으며 otpauth 주소를 글로 보인다', () => {
  needLive();
  for (const name of [
    'getPartnerAuthSecuritySettings',
    'getPartnerAuthSessions',
    'beginPartnerTotpEnrollment',
    'confirmPartnerTotpEnrollment',
    'recreatePartnerRecoveryCodes',
    'deletePartnerAuthSession',
  ]) {
    assert.match(live, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
    assert.match(api, new RegExp(`export async function ${name}\\(`), `${name}이 partner-live.ts에 없다`);
  }
  assert.doesNotMatch(live, /\bfetch\s*\(/);
  // QR 라이브러리가 없어 otpauth 주소와 비밀 키를 글로 보인다(계획 §4 [가정])
  assert.match(live, /otpauthUri/);
  assert.doesNotMatch(live, /QRCode|qrcode|qr-code|<canvas|new\s+Canvas/i);
});

test('I-T53 ③ [ASVS v5.0.0-7.5.1] 재인증은 ACCOUNT_SECURITY로 하고 패스키가 있는 계정만 withPasskey를 켠다', () => {
  needLive();
  assert.match(live, /requestAccountSecurityReauth/);
  assert.match(live, /ACCOUNT_SECURITY/);
  assert.match(live, /passkeyCount/);
  assert.match(live, /reauthWithPasskey\(/);
  assert.match(live, /withPasskey/);
  // 재인증 토큰은 머리로만 넘긴다
  assert.match(live, /reauthToken/);
  assert.doesNotMatch(live, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(live, /console\.(?:log|info|warn|error|debug)/);
});

test('I-T53 ③ [ASVS v5.0.0-7.5.2] 기기 로그아웃은 재인증 토큰을 X-Reauth-Token으로 보내고 404면 목록을 다시 읽는다', () => {
  needLive();
  assert.match(live, /deletePartnerAuthSession\(/);
  assert.match(live, /reauthToken/);
  assert.match(live, /session-not-found/);
  assert.match(live, /reload|refresh|다시 불러/);
  // 지금 기기 줄에는 로그아웃을 두지 않고, 다른 로그인이 있을 때만 '이 기기의 다른 로그인 끝내기'를 보인다
  assert.match(live, /deviceRowActions\(/);
  assert.match(live, /canEndOtherLogins/);
  assert.match(live, /canLogout/);
  assert.match(live, /이 기기의 다른 로그인 끝내기|다른 로그인 끝내기/);
});

test('I-T53 ③ [ASVS v5.0.0-6.4.4] 복구 코드는 한 번만 보이고 저장 확인 전에는 닫지 않으며 저장소·주소·로그에 남기지 않는다', () => {
  needLive();
  assert.match(live, /recoveryCodes/);
  assert.match(live, /저장했습니다|saved/i);
  // 저장 확인 전에는 닫기 버튼이 비활성이다(지역 변수 이름은 고정하지 않고 모델 판정을 쓴다)
  assert.match(live, /recoveryCodeDialogState\(/);
  assert.match(live, /closeEnabled/);
  assert.doesNotMatch(live, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(live, /history\.(?:push|replace)State|searchParams\.set/);
  assert.doesNotMatch(live, /console\.(?:log|info|warn|error|debug)/);
  // 닫거나 완료할 때 코드를 지운다
  assert.match(live, /set[A-Z][A-Za-z]*(?:Codes|RecoveryCodes)\(\[\]\)/);
});

test('I-T53 ③ 실제 보안 줄에는 목업 값(accountSecurity·loginDevices)이 0건이다', () => {
  needLive();
  // `accountSecurityView`·`accountSecurityProblemMessage`·`requestAccountSecurityReauth`는 실제 모델 이름이라 잡지 않는다
  assert.doesNotMatch(live, /\baccountSecurity\b|loginDevices|model\/settings|'9\/30'|'10\/2'|'Chrome · Windows · 20:01 KST'/);
});
