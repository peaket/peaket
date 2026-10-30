// 셸 없는 가운데 카드 틀(보드 SCR-020-m·t·d). 휴대폰은 카드 없이 바탕(surface) 위에 바로(바깥 여백 32·16·40, 사이 24),
// 태블릿·데스크톱은 바탕(surface-basement) 가운데 카드(폭 440, 초대 수락 480·lg 520, 안쪽 여백 32).
import type { ReactNode } from 'react';
import { cx } from '@/shared/lib/cx';

export interface AuthFrameProps {
  dark: boolean;
  /** main의 aria-labelledby(h1 id) */
  titleId: string;
  /** 초대 수락 카드는 넓다 */
  wide?: boolean;
  /** 카드 안 줄 사이(보드: 로그인 20, 초대 수락 24) */
  gap?: 20 | 24;
  children: ReactNode;
  /** 화면 밖에 두는 것(상태 고르기 등) */
  after?: ReactNode;
}

export function AuthFrame({ dark, titleId, wide = false, gap = 20, children, after }: AuthFrameProps) {
  return (
    <div className={cx('pk min-h-dvh bg-[var(--surface)] md:bg-[var(--surface-basement)]', dark && 'dark')}>
      <a
        className="sr-only focus:not-sr-only focus:!absolute focus:!left-2 focus:!top-2 focus:!z-[300] focus:!rounded-[var(--r-md)] focus:!bg-[var(--surface-raised)] focus:!p-2"
        href="#main"
      >
        본문 바로가기
      </a>
      <main
        id="main"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="flex flex-col px-4 pb-10 pt-8 md:min-h-dvh md:items-center md:justify-center md:px-6 md:py-12"
      >
        <div
          className={cx(
            'card col w-full gap-6 max-md:rounded-none max-md:border-0 max-md:bg-transparent md:p-8 md:[box-shadow:var(--shadow-sm)]',
            gap === 20 ? 'md:gap-5' : 'md:gap-6',
            wide ? 'md:max-w-[480px] lg:max-w-[520px]' : 'md:max-w-[440px]',
          )}
        >
          <div className="row" style={{ gap: 8 }}>
            <span className="logo logo-sm">
              <i className="logo-mark" aria-hidden="true" />
              PEAKET
            </span>
            <span className="badge badge-primary">파트너</span>
          </div>
          {children}
        </div>
      </main>
      {after}
    </div>
  );
}

/** 잠김·만료·성공 같은 결과 상자(아이콘 원 + 제목 + 한 줄). 휴대폰은 안쪽 여백 20·16 */
export function ResultBlock({
  tone,
  icon,
  title,
  body,
  role = 'alert',
  mutedBody = false,
}: {
  tone: 'warning' | 'danger' | 'success' | 'neutral';
  icon: string;
  title: string;
  body: string;
  role?: 'alert' | 'status';
  mutedBody?: boolean;
}) {
  const bg = tone === 'neutral' ? 'var(--surface-muted)' : `var(--${tone}-subtle)`;
  return (
    <div
      className="col px-4 py-5 md:p-5"
      role={role}
      style={{ gap: 12, alignItems: 'flex-start', borderRadius: 'var(--r-lg)', background: bg }}
    >
      <span className={tone === 'neutral' ? 'state-icon' : `state-icon is-${tone}`} style={{ width: 56, height: 56, background: 'var(--surface)' }}>
        <i className={`ic ${icon}`} aria-hidden="true" />
      </span>
      <h2 className="t-lg">{title}</h2>
      <p className={mutedBody ? 't-sm muted' : 't-sm'}>{body}</p>
    </div>
  );
}

/** 단계 막대의 한 칸(완료·지금·다음) */
export function Step({ n, label, status }: { n: number; label: string; status: 'done' | 'current' | 'upcoming' }) {
  return (
    <span className={cx('step', status === 'done' && 'is-done', status === 'current' && 'is-current')} aria-current={status === 'current' ? 'step' : undefined}>
      <span className="step-num">{status === 'done' ? <i className="ic ic-check" aria-hidden="true" /> : n}</span>
      {label}
      {status === 'done' ? <span className="sr-only">(완료)</span> : null}
    </span>
  );
}

/** 로그인 두 단계 막대 */
export function LoginStepper({ current }: { current: 1 | 2 }) {
  return (
    <nav className="stepper" aria-label="로그인 단계">
      <Step n={1} label="이메일·비밀번호" status={current === 1 ? 'current' : 'done'} />
      <span className={current === 2 ? 'step-line is-done' : 'step-line'} />
      <Step n={2} label="인증 앱 코드" status={current === 2 ? 'current' : 'upcoming'} />
    </nav>
  );
}

/** 링크 모양의 버튼(대상 경로가 정본에 없는 '복구 코드로 …') */
export function TextButton({ children }: { children: ReactNode }) {
  return (
    <button className="link-more" type="button" style={{ alignSelf: 'flex-start', background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}>
      {children}
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </button>
  );
}
