// SCR-004 로그인(d5 §5.4, d3 SCR-004 행, 캔버스 보드 SCR-004-m·t·d를 한 페이지 반응형으로 합쳤다).
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 카드(최대 400)로 바뀐다. 셸은 로그인 전 모양.
// 세 제공자 버튼은 가이드 색·문구(키트 btn-kakao·btn-naver·btn-google)로 같은 크기·같은 비중으로 쌓는다(ADR-0062).
// 상태는 ?state=(보드 state 값 + d5 §3.5 세션 종료 사유), 다크는 ?theme=dark.
import Link from 'next/link';
import { LogoWordmark } from '@peaket/ds/LogoWordmark';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { LOGIN_PROVIDERS, PROVIDER_LOGIN_LABEL, PROVIDER_NAME, SESSION_END_TEXT, type ProviderId } from '@/entities/provider';
import { SCR004_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { loginView, type LoginView } from '../model/state';

/** 장애가 난 제공자(보드 '제공자 장애'는 카카오) */
const DOWN: ProviderId = 'kakao';
/** 진행 중일 때 누른 제공자 */
const PRESSED: ProviderId = 'kakao';

/** 언어 고르기: 주소 접두로 이동한다(ADR-0060 결정 3) */
const LOCALES = [
  { lang: 'en', label: 'English' },
  { lang: 'ja', label: '日本語' },
  { lang: 'zh', label: '中文' },
] as const;

export async function LoginPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR004_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = loginView(state);

  return (
    <AppShell dark={dark} guest>
      <main
        className="page-main justify-center px-4 pt-8 pb-12 md:items-center md:bg-(--surface-basement) md:px-6 md:pt-14 md:pb-[72px] lg:px-8 lg:pt-16 lg:pb-20"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[400px] gap-6 md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-7 md:pt-9 md:pb-8">
          <div className="col items-center text-center" style={{ gap: 16 }}>
            <LogoWordmark size="lg" />
            {v.sessionEnd ? (
              <NoticeBanner tone="warning" icon="logout" role="alert" style={{ width: '100%', textAlign: 'left' }}>
                {SESSION_END_TEXT[v.sessionEnd]}
              </NoticeBanner>
            ) : null}
            <h1 className="t-lg">공연 예매는 소셜 계정으로 로그인합니다</h1>
          </div>

          {v.error ? (
            <NoticeBanner tone="danger" role="alert">
              로그인에 실패했습니다. 다시 시도해 주세요
            </NoticeBanner>
          ) : null}

          <div className="col" style={{ gap: 10 }} role="group" aria-label="소셜 계정으로 로그인">
            {LOGIN_PROVIDERS.map((p) => (
              <ProviderButton key={p} provider={p} view={v} />
            ))}
          </div>

          <div className="col items-center" style={{ gap: 14 }}>
            <nav className="row wrap center" aria-label="약관과 정책" style={{ gap: '4px 20px' }}>
              <Link className="link-more" href="/policy/privacy">
                개인정보 처리방침
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
              <Link className="link-more" href="/policy/terms">
                이용약관
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </nav>
            <nav className="row wrap center t-sm" aria-label="언어 선택" style={{ gap: '4px 14px' }}>
              <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
              <a className="fw-b" href="/login" aria-current="true" style={{ color: 'inherit' }}>
                한국어
              </a>
              {LOCALES.map((l) => (
                <a key={l.lang} href={`/${l.lang}/login`} lang={l.lang} hrefLang={l.lang}>
                  {l.label}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </main>
      <PreviewSwitcher path="/login" states={SCR004_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

/** 제공자 가이드 버튼 하나. 진행 중이면 누른 버튼만 스피너(aria-busy), 나머지는 비활성. 장애면 그 버튼만 이유 있는 비활성 + 이유 글 */
function ProviderButton({ provider, view }: { provider: ProviderId; view: LoginView }) {
  const cls = `btn btn-${provider} btn-lg btn-block`;
  const label = PROVIDER_LOGIN_LABEL[provider];
  const mark = <i className={`prov prov-${provider}`} aria-hidden="true" />;

  if (view.busy) {
    return provider === PRESSED ? (
      <button className={cls} type="button" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        {label}
      </button>
    ) : (
      <button className={cls} type="button" disabled>
        {mark}
        {label}
      </button>
    );
  }

  if (view.outage && provider === DOWN) {
    const why = `${provider}-down`;
    return (
      <div className="col" style={{ gap: 8 }}>
        <button className={cls} type="button" aria-disabled="true" aria-describedby={why}>
          {mark}
          {label}
        </button>
        <p className="row t-sm tx-warning" id={why} role="status" style={{ alignItems: 'flex-start', gap: 6 }}>
          <i className="ic ic-alert ic-16" aria-hidden="true" />
          <span>지금은 {PROVIDER_NAME[provider]} 로그인을 쓸 수 없습니다</span>
        </p>
      </div>
    );
  }

  return (
    <button className={cls} type="button">
      {mark}
      {label}
    </button>
  );
}
