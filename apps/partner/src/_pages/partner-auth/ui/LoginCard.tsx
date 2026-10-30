// 파트너 로그인 카드(보드 SCR-020 isLogin 블록): 1단계 이메일·비밀번호 → 2단계 인증 앱 코드, 실패·사람 확인·시간 잠금·보호 잠금,
// 세션 종료 안내 배너, 초대 만료(보드는 초대 만료도 이 로그인 카드 안에 그린다).
// 버튼 중 다음 화면이 정해진 것은 퍼블리싱 확인용으로 그 상태·경로로 잇는다(실제 제출은 데이터 연결 단계에서).
import Link from 'next/link';
import { previewHref } from '@peaket/ds/Preview';
import { me } from '@/entities/partner-user';
import { routes } from '@/shared/config/routes';
import { RESEND_NEXT_AT, SESSION_END_MESSAGES } from '../model/messages';
import { LoginStepper, ResultBlock, TextButton } from './AuthFrame';
import { PasswordInput } from './PasswordInput';

export type LoginCardState =
  | '로그인 1단계'
  | '인증 중'
  | 'TOTP 2단계'
  | '실패'
  | '반복 실패'
  | '시간 잠금'
  | '보호 잠금'
  | '해제 링크 다시 받기 한도'
  | '세션 종료 · 권한 바뀜'
  | '세션 종료 · 비밀번호 바뀜'
  | '세션 종료 · 계정 삭제'
  | '초대 만료';

export function LoginCard({ state, keep }: { state: LoginCardState; keep: Record<string, string | undefined> }) {
  const sessEnd = SESSION_END_MESSAGES[state];
  const isS1 = state === '로그인 1단계' || state === '인증 중' || sessEnd !== undefined;
  const isS2 = state === 'TOTP 2단계';
  const isFail = state === '실패' || state === '반복 실패';
  const isTimeLock = state === '시간 잠금' || state === '해제 링크 다시 받기 한도';
  const isProtect = state === '보호 잠금';
  const isExpired = state === '초대 만료';
  const notLocked = !isTimeLock && !isProtect && !isExpired;
  const loginHref = previewHref(routes.login(), undefined, keep);

  return (
    <>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-xl" id="lg-title">
          파트너 로그인
        </h1>
        <p className="t-sm muted">업무용 이메일, 비밀번호, 인증 앱 코드로 로그인합니다.</p>
      </div>

      {sessEnd ? (
        <div className="banner banner-info" role="status">
          <i className="ic ic-logout" aria-hidden="true" />
          <div className="banner-body">{sessEnd}</div>
        </div>
      ) : null}

      {isS1 ? <StepOne busy={state === '인증 중'} nextHref={previewHref(routes.login(), 'TOTP 2단계', keep)} /> : null}

      {isS2 ? (
        <div className="col" style={{ gap: 20 }}>
          <LoginStepper current={2} />
          <p className="t-sm muted">
            <span className="fw-b" style={{ color: 'var(--text)' }}>
              {me.email}
            </span>{' '}
            계정입니다. 휴대폰의 인증 앱을 여세요.
          </p>
          <form className="col" style={{ gap: 16 }} aria-label="2단계 인증 앱 코드">
            <div className="field">
              <label className="label" htmlFor="s2-otp">
                인증 앱의 6자리 코드
              </label>
              <input
                className="otp-input"
                id="s2-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                aria-describedby="s2-otp-h"
                autoFocus
              />
              <span className="hint" id="s2-otp-h">
                이 단계로 오면 첫 칸에 바로 입력할 수 있습니다
              </span>
            </div>
            <TextButton>복구 코드로 로그인</TextButton>
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn btn-outline btn-lg" href={loginHref}>
                이전
              </Link>
              <Link className="btn btn-primary btn-lg grow" href={routes.events()}>
                로그인
              </Link>
            </div>
          </form>
        </div>
      ) : null}

      {isFail ? (
        <div className="col" style={{ gap: 20 }}>
          <LoginStepper current={1} />
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">이메일이나 비밀번호가 맞지 않습니다</span>
              남은 시도 {state === '반복 실패' ? 2 : 4}회
            </div>
          </div>
          <form className="col" style={{ gap: 16 }} aria-label="1단계 이메일과 비밀번호">
            <div className="field">
              <label className="label" htmlFor="s3-email">
                업무용 이메일
              </label>
              <input className="input" id="s3-email" type="email" autoComplete="username" defaultValue={me.email} />
            </div>
            <div className="field">
              <label className="label" htmlFor="s3-pw">
                비밀번호
              </label>
              <PasswordInput id="s3-pw" autoComplete="current-password" toggleLabel="비밀번호 보기" autoFocus />
            </div>
            {state === '반복 실패' ? (
              <div className="field">
                <span className="label" id="s3-hc-l">
                  사람 확인
                </span>
                {/* 사람 확인 위젯 자리(실제 위젯은 BOT-010에서 붙인다, design.md 결정 8) */}
                <div
                  className="center t-sm muted"
                  role="group"
                  aria-labelledby="s3-hc-l"
                  aria-describedby="s3-hc-h"
                  style={{
                    height: 72,
                    padding: '0 16px',
                    border: '1px dashed var(--border-input)',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--surface-muted)',
                    textAlign: 'center',
                  }}
                >
                  사람 확인 창이 이 자리에 열립니다
                </div>
                <span className="hint" id="s3-hc-h">
                  로그인 실패가 반복되어 사람 확인을 마친 뒤 다시 시도합니다. 5회 연속 실패하면 계정이 잠깁니다(남은 시도 2회)
                </span>
              </div>
            ) : null}
            <Link className="btn btn-primary btn-lg btn-block" href={previewHref(routes.login(), 'TOTP 2단계', keep)}>
              다음
            </Link>
          </form>
        </div>
      ) : null}

      {isTimeLock ? (
        <div className="col" style={{ gap: 20 }}>
          <ResultBlock tone="warning" icon="ic-clock" title="계정이 15분 동안 잠겼습니다." body="업무 이메일로 보낸 링크에서 인증 앱 코드를 넣으면 바로 풀립니다" />
          <button
            className="btn btn-primary btn-lg btn-block"
            type="button"
            aria-describedby={state === '해제 링크 다시 받기 한도' ? 's5-lim' : undefined}
          >
            <i className="ic ic-mail" aria-hidden="true" />
            해제 링크 다시 받기
          </button>
          {state === '해제 링크 다시 받기 한도' ? (
            <span className="error-msg" id="s5-lim" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              해제 링크는 1시간에 3번까지 다시 받을 수 있습니다. {RESEND_NEXT_AT} 뒤에 다시 시도하세요
            </span>
          ) : null}
          <Link className="btn btn-outline btn-lg btn-block" href={loginHref}>
            로그인 화면으로 돌아가기
          </Link>
        </div>
      ) : null}

      {isExpired ? (
        <div className="col" style={{ gap: 20 }}>
          <ResultBlock tone="neutral" icon="ic-mail" title="초대가 만료되었습니다. 운영자에게 다시 요청하세요" body="초대 링크는 24시간 동안 한 번 쓸 수 있습니다." mutedBody />
          <Link className="btn btn-outline btn-lg btn-block" href={loginHref}>
            로그인 화면으로 돌아가기
          </Link>
        </div>
      ) : null}

      {isProtect ? (
        <div className="col" style={{ gap: 20 }}>
          <ResultBlock tone="danger" icon="ic-lock" title="보안을 위해 계정을 잠갔습니다." body="운영자 확인 후 재초대됩니다" />
          <ul className="col t-sm muted" style={{ gap: 8 }}>
            <li className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <i className="ic ic-mail ic-16" aria-hidden="true" style={{ marginTop: 2 }} />
              <span>재초대 링크는 업무용 이메일로 받습니다. 링크는 24시간 동안 한 번 쓸 수 있습니다.</span>
            </li>
            <li className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <i className="ic ic-key ic-16" aria-hidden="true" style={{ marginTop: 2 }} />
              <span>새 링크로 비밀번호와 인증 앱을 다시 등록합니다.</span>
            </li>
          </ul>
          <Link className="btn btn-outline btn-lg btn-block" href={loginHref}>
            로그인 화면으로 돌아가기
          </Link>
        </div>
      ) : null}

      {notLocked ? (
        <div className="col" style={{ gap: 16 }}>
          <hr className="divider" />
          <p className="t-sm muted">비밀번호를 잊었으면 PEAKET 운영자에게 재초대를 요청하세요</p>
        </div>
      ) : null}
    </>
  );
}

function StepOne({ busy, nextHref }: { busy: boolean; nextHref: string }) {
  return (
    <div className="col" style={{ gap: 20 }}>
      <LoginStepper current={1} />
      <form className="col" style={{ gap: 16 }} aria-label="1단계 이메일과 비밀번호" aria-busy={busy || undefined}>
        <div className="field">
          <label className="label" htmlFor="s1-email">
            업무용 이메일
          </label>
          <input className="input" id="s1-email" type="email" autoComplete="username" defaultValue={me.email} />
        </div>
        <div className="field">
          <label className="label" htmlFor="s1-pw">
            비밀번호
          </label>
          <PasswordInput
            id="s1-pw"
            autoComplete="current-password"
            toggleLabel="비밀번호 보기"
            defaultValue="0000000000000000"
            describedBy="s1-pw-h"
          />
          <span className="hint" id="s1-pw-h">
            붙여넣기와 비밀번호 관리자 자동 입력을 쓸 수 있습니다
          </span>
        </div>
        {busy ? (
          // d5 §6.1 '인증 중': 제출 뒤 버튼 스피너(보드에 없는 상태)
          <button className="btn btn-primary btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="s1-busy">
            <span className="spinner" aria-hidden="true" />
            다음
          </button>
        ) : (
          <Link className="btn btn-primary btn-lg btn-block" href={nextHref}>
            다음
          </Link>
        )}
        {busy ? (
          <span className="sr-only" id="s1-busy" role="status">
            이메일과 비밀번호를 확인하고 있습니다
          </span>
        ) : null}
      </form>
    </div>
  );
}
