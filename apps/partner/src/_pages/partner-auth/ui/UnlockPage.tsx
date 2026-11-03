// SCR-020 계정 잠금 풀기(/unlock#token=, d5 §6.1 '잠금 해제 화면', 보드 SCR-020 isUnlock 블록). 셸 없이 가운데 카드.
// 실제 화면은 열리자마자 주소에서 토큰을 지운다(초대 링크와 같은 URL 조각 규칙). 퍼블리싱에서는 토큰을 다루지 않는다.
import Link from 'next/link';
import { previewHref } from '@peaket/ds/Preview';
import { routes } from '@/shared/config/routes';
import { UNLOCK_STATES } from '@/shared/config/states/scr020-auth';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { UNLOCK_ATTEMPTS_LEFT } from '../model/messages';
import { AuthFrame, ResultBlock, TextButton } from './AuthFrame';

export default async function UnlockPage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, UNLOCK_STATES, '잠금 해제 화면');
  const wrong = pv.state === '잠금 해제 · 코드 틀림';
  const done = pv.state === '잠금 해제 · 성공';
  const bad = pv.state === '잠금 해제 · 쓸 수 없는 링크';
  const loginHref = previewHref(routes.login(), undefined, pv.keep);
  return (
    <AuthFrame
      dark={pv.theme === 'dark'}
      titleId="ul-title"
      after={<PreviewStateSwitcher path={routes.unlock()} states={UNLOCK_STATES} current={pv.state} keep={pv.keep} />}
    >
      <h1 className="t-xl" id="ul-title">
        계정 잠금 풀기
      </h1>

      {!done && !bad ? (
        <div className="col" style={{ gap: 20 }}>
          <p className="t-sm" id="ul-d">
            인증 앱의 6자리 코드나 복구 코드를 넣으면 잠금이 풀립니다. 그 뒤 비밀번호와 인증 앱 코드로 로그인합니다.
          </p>
          <form className="col" style={{ gap: 16 }} aria-label="계정 잠금 풀기">
            <div className="field">
              <label className="label" htmlFor="ul-otp">
                인증 앱의 6자리 코드
              </label>
              <input
                className="otp-input"
                id="ul-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                aria-invalid={wrong ? 'true' : undefined}
                aria-describedby={wrong ? 'ul-e' : 'ul-d'}
                autoFocus
              />
              {wrong ? (
                <span className="error-msg" id="ul-e" role="alert">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  코드가 맞지 않습니다. 이 링크로 {UNLOCK_ATTEMPTS_LEFT}번 더 시도할 수 있습니다
                </span>
              ) : null}
            </div>
            <TextButton>복구 코드로 풀기</TextButton>
            <Link className="btn btn-primary btn-lg btn-block" href={previewHref(routes.unlock(), '잠금 해제 · 성공', pv.keep)}>
              잠금 풀기
            </Link>
          </form>
        </div>
      ) : null}

      {done ? (
        <div className="col" style={{ gap: 20 }}>
          <ResultBlock tone="success" icon="ic-check-circle" title="잠금을 풀었습니다." body="다시 로그인해 주세요" role="status" />
          <Link className="btn btn-primary btn-lg btn-block" href={loginHref}>
            로그인
          </Link>
        </div>
      ) : null}

      {bad ? (
        <div className="col" style={{ gap: 20 }}>
          <ResultBlock tone="neutral" icon="ic-ban" title="이 링크는 더 쓸 수 없습니다." body="로그인 화면에서 [해제 링크 다시 받기]를 누르세요" />
          <Link className="btn btn-outline btn-lg btn-block" href={loginHref}>
            로그인 화면으로
          </Link>
        </div>
      ) : null}
    </AuthFrame>
  );
}
