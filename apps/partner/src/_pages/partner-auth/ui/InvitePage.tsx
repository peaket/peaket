// SCR-020 파트너 초대 수락(/invite#token=, d5 §6.1 ④, 보드 SCR-020 isInvite 블록). 셸 없이 가운데 카드(폭 480·lg 520).
// 단계: 비밀번호 만들기 → 인증 앱 등록 → 패스키 등록 → 복구 코드 보관. 보드는 2·3단계를 그렸다.
// '초대 만료'는 보드처럼 로그인 카드 안에 그린다. 실제 화면은 열리자마자 주소에서 토큰을 지운다.
import Link from 'next/link';
import { previewHref } from '@peaket/ds/Preview';
import { stellaOrg } from '@/entities/partner-org';
import { routes } from '@/shared/config/routes';
import { INVITE_STATES } from '@/shared/config/states/scr020-auth';
import { cx } from '@/shared/lib/cx';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { qrCells } from '../model/qr';
import { AuthFrame, Step, TextButton } from './AuthFrame';
import { LoginCard } from './LoginCard';

const STEPS = ['비밀번호 만들기', '인증 앱 등록', '패스키 등록', '복구 코드 보관'] as const;
const QR = qrCells(23);

export default async function InvitePage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, INVITE_STATES, '초대 수락');
  const switcher = <PreviewStateSwitcher path={routes.invite()} states={INVITE_STATES} current={pv.state} keep={pv.keep} />;
  const dark = pv.theme === 'dark';

  if (pv.state === '초대 만료') {
    return (
      <AuthFrame dark={dark} titleId="lg-title" after={switcher}>
        <LoginCard state="초대 만료" keep={pv.keep} />
      </AuthFrame>
    );
  }

  const isKey = pv.state === '초대 수락 · 패스키 등록';
  return (
    <AuthFrame dark={dark} titleId="iv-title" wide gap={24} after={switcher}>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-xl" id="iv-title">
          파트너 초대 수락
        </h1>
        <p className="t-sm muted">{stellaOrg.name}의 파트너 콘솔 초대입니다. 초대 링크는 24시간 동안 한 번 쓸 수 있습니다.</p>
      </div>

      <InviteStepper current={isKey ? 3 : 2} />

      {isKey ? (
        <section className="col" style={{ gap: 16 }} aria-labelledby="ik-h2">
          <div className="col" style={{ gap: 6 }}>
            <h2 className="t-lg" id="ik-h2">
              패스키 등록
            </h2>
            <p className="t-sm muted" id="ik-d">
              정산 계좌 변경·명단 내려받기·역할 변경을 할 때 한 번 더 확인하는 데 씁니다
            </p>
          </div>
          <div className="banner banner-info">
            <i className="ic ic-key" aria-hidden="true" />
            <div className="banner-body">파트너 관리자는 이 단계를 마쳐야 계정이 활성화됩니다. 패스키는 인증 앱을 대신하지 않습니다.</div>
          </div>
          <button className="btn btn-primary btn-lg btn-block" type="button" aria-describedby="ik-d" autoFocus>
            <i className="ic ic-key" aria-hidden="true" />
            패스키 등록
          </button>
          {/* 실무자는 건너뛸 수 있다(d5 §6.1 ④, POL-020). 보드는 관리자 그림이라 ?role=member일 때만 보인다 */}
          {pv.isMember ? <TextButton>나중에 등록</TextButton> : null}
          <p className="t-xs muted">다음 단계에서 복구 코드 10개를 받아 보관합니다.</p>
        </section>
      ) : (
        <>
          <section className="col" style={{ gap: 16 }} aria-labelledby="iv-h2">
            <div className="col" style={{ gap: 6 }}>
              <h2 className="t-lg" id="iv-h2">
                인증 앱 등록
              </h2>
              <p className="t-sm muted max-md:hidden">휴대폰의 인증 앱으로 QR을 찍습니다. 인증 앱이 이 기기에 있으면 설정 키를 복사해 붙여 넣습니다.</p>
              <p className="t-sm muted md:hidden">다른 기기의 인증 앱으로 아래 QR을 찍거나, 이 휴대폰의 인증 앱에 설정 키를 붙여 넣습니다.</p>
            </div>
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-5">
              <QrImage className="max-md:hidden" width={164} label="인증 앱 등록 QR. 오른쪽 설정 키와 같은 내용입니다" />
              <QrImage className="self-center md:hidden" width={176} label="인증 앱 등록 QR. 이 휴대폰의 카메라로는 찍을 수 없어 아래에 설정 키를 함께 보입니다" />
              <div className="col grow" style={{ gap: 8 }}>
                <p className="label">설정 키</p>
                <p className="code px-3.5 py-2.5 text-center text-[15px] leading-[22px] md:px-3 md:text-left md:text-[14px] md:leading-[20px]">
                  [설정 키 자리 표시]
                </p>
                <button className="btn btn-outline btn-block" type="button" aria-describedby="iv-key-h">
                  <i className="ic ic-copy" aria-hidden="true" />
                  설정 키 복사
                </button>
                <span className="hint" id="iv-key-h">
                  인증 앱에서 설정 키로 계정을 추가하는 메뉴를 고른 뒤 붙여 넣습니다
                </span>
              </div>
            </div>
            <div className="banner banner-info">
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body">
                휴대폰으로 로그인해 승인할 예정이라면, 휴대폰을 잃을 때 인증 앱까지 함께 잃지 않도록 인증 앱은 다른 기기에 등록하기를 권합니다.
              </div>
            </div>
          </section>

          <form className="col" style={{ gap: 16 }} aria-label="인증 앱 등록 확인">
            <div className="field">
              <label className="label" htmlFor="iv-otp">
                인증 앱의 6자리 코드
              </label>
              <input
                className="otp-input"
                id="iv-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]*"
                aria-describedby="iv-otp-h"
              />
              <span className="hint" id="iv-otp-h">
                등록한 인증 앱에 보이는 코드로 확인합니다
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-outline btn-lg" type="button">
                이전
              </button>
              <Link className="btn btn-primary btn-lg grow" href={previewHref(routes.invite(), '초대 수락 · 패스키 등록', pv.keep)}>
                인증 앱 등록하기
              </Link>
            </div>
            <p className="t-xs muted">다음 단계에서 패스키를 등록합니다.</p>
          </form>
        </>
      )}
    </AuthFrame>
  );
}

/** 초대 수락 단계 막대: 데스크톱(lg)은 가로 한 줄, 태블릿·휴대폰은 네 칸 격자(번호 위·이름 아래, 보드 SCR-020-t·m) */
function InviteStepper({ current }: { current: 2 | 3 }) {
  const status = (i: number) => (i + 1 < current ? 'done' : i + 1 === current ? 'current' : 'upcoming') as 'done' | 'current' | 'upcoming';
  return (
    <>
      <nav className="stepper max-lg:hidden" aria-label="초대 수락 단계">
        {STEPS.map((label, i) => (
          <span key={label} className="contents">
            {i > 0 ? <span className={status(i - 1) === 'done' ? 'step-line is-done' : 'step-line'} /> : null}
            <Step n={i + 1} label={label} status={status(i)} />
          </span>
        ))}
      </nav>
      <nav className="stepper grid grid-cols-4 items-start gap-0 lg:hidden" aria-label="초대 수락 단계">
        {STEPS.map((label, i) => {
          const st = status(i);
          return (
            <span
              key={label}
              className={cx('step', st === 'done' && 'is-done', st === 'current' && 'is-current')}
              aria-current={st === 'current' ? 'step' : undefined}
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, whiteSpace: 'normal' }}
            >
              <span className="row" style={{ gap: 6 }}>
                <span className="step-num">{st === 'done' ? <i className="ic ic-check" aria-hidden="true" /> : i + 1}</span>
                {i < STEPS.length - 1 ? <span className={st === 'done' ? 'step-line is-done' : 'step-line'} style={{ marginRight: 6 }} /> : null}
              </span>
              <span>
                {label}
                {st === 'done' ? <span className="sr-only">(완료)</span> : null}
              </span>
            </span>
          );
        })}
      </nav>
    </>
  );
}

function QrImage({ width, label, className }: { width: number; label: string; className: string }) {
  return (
    <div className={cx('qr-wrap', className)} style={{ width, flex: 'none' }} role="img" aria-label={label}>
      <div className="qr">
        {QR.map((on, i) => (
          <i key={i} className={on ? 'on' : undefined} />
        ))}
      </div>
    </div>
  );
}
