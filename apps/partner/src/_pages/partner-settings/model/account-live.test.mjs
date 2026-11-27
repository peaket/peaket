// F-07-13 SCR-020 '내 계정' 실제 판의 화면 모델 시험(계획 §4·§6, d5 §6.1 ⑦, ASVS 6.4.4·7.5.1·7.5.2).
// 시험이 정한 모양(계획 §4 '화면 모델'에 이름만 있어 시험 담당이 정함, 시험 리뷰가 본다):
//   accountSecurityView(raw) → { totpText, recoveryText, passkeyCount, sessionLimit }
//     raw = GET /v1/partner/auth/security-settings 200 본문. 남은 코드는 0~10으로 자른다.
//   deviceSessionsView(items, now) → { sessionId, label, lastActiveText, current, otherSessions }[]
//     지금 기기 줄이 맨 앞, 나머지는 마지막 활동이 늦은 순. lastActiveText는 KST(오늘은 HH:mm, 다른 날은 M/D HH:mm) + ' KST'.
//   accountSecurityProblemMessage(problem) → 화면에 보일 글. 서버 title·detail 원문은 싣지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = () => import('./account-live.ts');

const setting = (over = {}) => ({ totpRegistered: true, recoveryCodesRemaining: 7, passkeyCount: 1, sessionLimit: 2, ...over });
const device = (over = {}) => ({
  sessionId: '0190f3a1-7c2e-7a00-8000-00000000d001',
  deviceName: 'Chrome · Windows',
  lastActiveAt: '2026-11-27T11:00:00.000Z',
  current: false,
  otherSessions: 0,
  ...over,
});

test('I-T53 ③ [ASVS v5.0.0-6.4.4] 보안 요약은 인증 앱 등록 여부와 남은 복구 코드 수를 0~10으로 보이고 화면 모드·재인증 패스키·기기 줄 동작·복구 코드 닫기 상태를 값으로 가른다', async () => {
  const { accountSecurityView } = await mod();
  assert.deepEqual(accountSecurityView(setting()), { totpText: '등록됨', recoveryText: '남은 코드 7개', passkeyCount: 1, sessionLimit: 2 });
  assert.deepEqual(accountSecurityView(setting({ totpRegistered: false, recoveryCodesRemaining: 0, passkeyCount: 0 })), {
    totpText: '등록되지 않음',
    recoveryText: '남은 코드 0개',
    passkeyCount: 0,
    sessionLimit: 2,
  });
  assert.equal(accountSecurityView(setting({ recoveryCodesRemaining: 10 })).recoveryText, '남은 코드 10개');
  // 서버가 11을 주어도 화면은 10개로 자른다(정본 10개 [가정])
  assert.equal(accountSecurityView(setting({ recoveryCodesRemaining: 11 })).recoveryText, '남은 코드 10개');
  // 음수·모르는 값은 0으로 자른다
  assert.equal(accountSecurityView(setting({ recoveryCodesRemaining: -1 })).recoveryText, '남은 코드 0개');

  // 화면 모드·재인증 패스키·기기 줄 동작·복구 코드 닫기 상태도 같은 모델에서 값으로 가른다
  const { accountPageMode, reauthWithPasskey, deviceRowActions, recoveryCodeDialogState } = await mod();
  assert.equal(accountPageMode(undefined), 'live');
  assert.equal(accountPageMode('내 계정'), 'preview');
  assert.equal(reauthWithPasskey(0), false);
  assert.equal(reauthWithPasskey(1), true);
  assert.equal(reauthWithPasskey(2), true);
  assert.equal(reauthWithPasskey(-1), false);
  assert.equal(reauthWithPasskey(1.5), false);
  assert.deepEqual(deviceRowActions({ current: true, otherSessions: 0 }), { canLogout: false, canEndOtherLogins: false });
  assert.deepEqual(deviceRowActions({ current: true, otherSessions: 1 }), { canLogout: false, canEndOtherLogins: true });
  assert.deepEqual(deviceRowActions({ current: false, otherSessions: 0 }), { canLogout: true, canEndOtherLogins: false });
  assert.equal(recoveryCodeDialogState(false).closeEnabled, false);
  assert.equal(recoveryCodeDialogState(true).closeEnabled, true);
});

test('I-T53 ③ [ASVS v5.0.0-7.5.2] 기기 목록은 지금 기기를 맨 앞에 두고 마지막 활동을 KST로 보이며 이름이 없으면 알 수 없는 기기이고 40자까지 보인다', async () => {
  const { deviceSessionsView } = await mod();
  const now = Date.parse('2026-11-27T11:05:00.000Z'); // 2026-11-27 20:05 KST
  const rows = deviceSessionsView(
    [
      device({ sessionId: 'b', deviceName: 'Safari · iPad', lastActiveAt: '2026-11-26T10:00:00.000Z' }),
      device({ sessionId: 'a', deviceName: 'Chrome · Windows', lastActiveAt: '2026-11-27T11:00:00.000Z', current: true, otherSessions: 1 }),
      device({ sessionId: 'c', deviceName: null, lastActiveAt: '2026-11-25T10:00:00.000Z' }),
    ],
    now,
  );
  assert.deepEqual(rows.map((r) => r.sessionId), ['a', 'b', 'c']);
  assert.equal(rows[0].current, true);
  assert.equal(rows[0].otherSessions, 1);
  assert.equal(rows[0].label, '이 기기 · Chrome · Windows');
  assert.equal(rows[0].lastActiveText, '20:00 KST');
  assert.equal(rows[1].label, 'Safari · iPad');
  assert.equal(rows[1].lastActiveText, '11/26 19:00 KST');
  assert.equal(rows[2].label, '알 수 없는 기기');
  // 현재 기기 줄이 입력에 없으면 정렬만 하고 current는 거짓이다
  assert.equal(deviceSessionsView([device({ current: false })], now)[0].current, false);

  // 기기 이름은 40자까지 보이고 41자는 자르며 null·빈 값은 알 수 없는 기기다
  const { deviceNameText } = await mod();
  assert.equal(deviceNameText(null), '알 수 없는 기기');
  assert.equal(deviceNameText(''), '알 수 없는 기기');
  assert.equal(deviceNameText('   '), '알 수 없는 기기');
  const forty = '가'.repeat(40);
  assert.equal(deviceNameText(forty), forty);
  assert.equal(deviceNameText('가'.repeat(41)), '가'.repeat(40));
});

test('I-T53 ③ 마지막 활동의 KST 자정 경계는 날짜가 바뀌고, 읽지 못하는 값은 시간을 지어내지 않는다', async () => {
  const { deviceSessionsView } = await mod();
  const now = Date.parse('2026-11-27T11:05:00.000Z'); // 11/27 20:05 KST
  const at = (iso) => deviceSessionsView([device({ lastActiveAt: iso })], now)[0].lastActiveText;
  assert.equal(at('2026-11-26T14:59:59.000Z'), '11/26 23:59 KST');
  assert.equal(at('2026-11-26T15:00:00.000Z'), '00:00 KST');
  assert.equal(at('not-a-date'), '알 수 없음');
});

test('I-T53 ③ [ASVS v5.0.0-7.5.1] 재인증·확인 코드·만료·없는 세션 오류는 서로 다른 안내 글이고 서버 원문을 싣지 않는다', async () => {
  const { accountSecurityProblemMessage } = await mod();
  const m = {
    reauth: accountSecurityProblemMessage({ status: 403, type: 'reauth-required', title: '다시 인증해 주세요', detail: '서버 detail 원문' }),
    password: accountSecurityProblemMessage({ status: 403, type: 'password-change-required', title: '비밀번호를 바꿔 주세요' }),
    noTotp: accountSecurityProblemMessage({ status: 409, type: 'totp-not-registered', title: '등록된 인증 앱이 없습니다' }),
    expired: accountSecurityProblemMessage({ status: 410, type: 'totp-enrollment-invalid', title: '처음부터 다시 해 주세요' }),
    code: accountSecurityProblemMessage({ status: 422, type: 'reauth-code-invalid', title: '코드가 맞지 않습니다', remainingAttempts: 3 }),
    notFound: accountSecurityProblemMessage({ status: 404, type: 'session-not-found', title: '없는 세션' }),
    unavailable: accountSecurityProblemMessage({ status: 503, type: 'admin-login-unavailable', title: '잠시 뒤 다시' }),
  };
  assert.ok(m.reauth.includes('다시 인증'));
  assert.ok(m.password.includes('비밀번호'));
  assert.ok(m.noTotp.includes('인증 앱'));
  assert.ok(m.expired.includes('처음부터'));
  assert.ok(m.code.includes('3번') && m.code.includes('시도'));
  assert.ok(m.notFound.includes('로그아웃'));
  assert.ok(m.unavailable.includes('잠시 뒤'));
  assert.equal(new Set(Object.values(m)).size, 7);
  // 서버 title·detail 원문을 그대로 옮기지 않는다
  for (const text of Object.values(m)) assert.equal(text.includes('서버 detail 원문'), false);
  // 흔한 500은 하나의 안내로 모은다
  assert.equal(accountSecurityProblemMessage({ status: 500, type: 'internal', title: '서버 오류' }), accountSecurityProblemMessage({ status: 502, type: 'bad-gateway', title: '게이트웨이 오류' }));
});
