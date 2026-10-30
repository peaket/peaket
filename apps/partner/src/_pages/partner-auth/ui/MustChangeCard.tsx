// '비밀번호를 바꿔 주세요' 카드(보드 SCR-020 isMust 블록, d5 §6.1 '비밀번호를 바꿔야 하는 세션'). 셸 대신 이 카드만 보인다.
// 지금 비밀번호와 새 비밀번호를 함께 받는다(openapi currentPassword, ASVS 6.2.3). 바꾸면 토스트 뒤 SCR-062.
import Link from 'next/link';
import { routes } from '@/shared/config/routes';
import { PASSWORD_HINT, PASSWORD_REJECT_HINT, PASSWORD_REJECT_MESSAGES } from '../model/messages';
import { PasswordInput } from './PasswordInput';

export type MustChangeState =
  | '비밀번호를 바꿔야 하는 세션'
  | '비밀번호 바꾸기 · 지금 비밀번호 틀림'
  | '비밀번호 거절 · 유출'
  | '비밀번호 거절 · 금칙어'
  | '비밀번호 거절 · 흔한 비밀번호'
  | '비밀번호 거절 · 길이'
  | '비밀번호 확인 불가';

export function MustChangeCard({ state }: { state: MustChangeState }) {
  const base = state === '비밀번호를 바꿔야 하는 세션';
  const curBad = state === '비밀번호 바꾸기 · 지금 비밀번호 틀림';
  const rej = PASSWORD_REJECT_MESSAGES[state];
  const unavail = state === '비밀번호 확인 불가';
  const filled = base ? undefined : '0000000000000000';
  const newDesc = rej ? 'mc-new-e mc-new-h' : unavail ? 'mc-new-u mc-new-h' : 'mc-new-h';

  return (
    <>
      <div className="col" style={{ gap: 8 }}>
        <h1 className="t-xl" id="mc-title">
          비밀번호를 바꿔 주세요
        </h1>
        <p className="t-sm" id="mc-d">
          이 계정의 비밀번호가 다른 곳에 노출되었을 수 있어, 비밀번호를 바꾼 뒤에 콘솔을 쓸 수 있습니다. 바꾸면 이 계정의 다른 로그인 세션은 모두 끝납니다.
        </p>
      </div>
      <form className="col" style={{ gap: 16 }} aria-label="비밀번호 바꾸기" aria-describedby="mc-d">
        <div className="field">
          <label className="label" htmlFor="mc-cur">
            지금 비밀번호
          </label>
          <PasswordInput
            id="mc-cur"
            autoComplete="current-password"
            toggleLabel="지금 비밀번호 보기"
            defaultValue={curBad ? undefined : filled}
            invalid={curBad}
            describedBy={curBad ? 'mc-cur-e' : undefined}
            autoFocus={base || curBad}
          />
          {curBad ? (
            <span className="error-msg" id="mc-cur-e" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              지금 비밀번호가 맞지 않습니다
            </span>
          ) : null}
        </div>
        <div className="field">
          <label className="label" htmlFor="mc-new">
            새 비밀번호
          </label>
          <PasswordInput
            id="mc-new"
            autoComplete="new-password"
            toggleLabel="새 비밀번호 보기"
            defaultValue={rej ? '0000000000000000' : filled}
            invalid={rej !== undefined}
            describedBy={newDesc}
            autoFocus={rej !== undefined}
          />
          {rej ? (
            <span className="error-msg" id="mc-new-e" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {rej}
            </span>
          ) : null}
          {unavail ? (
            <span className="error-msg" id="mc-new-u" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              지금은 비밀번호를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요
            </span>
          ) : null}
          <span className="hint" id="mc-new-h">
            {rej ? PASSWORD_REJECT_HINT : PASSWORD_HINT}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn btn-outline btn-lg" href={routes.login()}>
            로그아웃
          </Link>
          <Link className="btn btn-primary btn-lg grow" href={routes.events()}>
            비밀번호 바꾸기
          </Link>
        </div>
      </form>
    </>
  );
}
