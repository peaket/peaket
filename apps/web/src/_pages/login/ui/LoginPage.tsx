// SCR-004 로그인(d5 §5.4, d3 SCR-004 행, 캔버스 보드 SCR-004-m·t·d를 한 페이지 반응형으로 합쳤다).
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 카드(최대 400)로 바뀐다. 셸은 로그인 전 모양.
// 세 제공자 버튼은 가이드 색·문구(키트 btn-kakao·btn-naver·btn-google)로 같은 크기·같은 비중으로 쌓는다(ADR-0062).
// 상태는 주소로 읽는다(ADR-0202 결정 5): 로그인 경로가 돌려보낸 error=failed·error=down&provider=, 세션 종료 사유 ended=, 돌아갈 주소 next=.
// 퍼블리싱 상태 미리보기(?state=)는 HOT-321에서 걷었다. 다크는 ?theme=dark(키트 미리보기).
import Link from 'next/link';
import { LogoWordmark } from '@peaket/ds/LogoWordmark';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { resolvePreviewTheme } from '@peaket/ds/Preview';
import { SESSION_END_TEXT } from '@/entities/provider';
import { DomesticPhoneNotice } from '@/shared/i18n/DomesticPhoneNotice';
import { localePath, type Locale } from '@/shared/i18n/catalog';
import { domesticPhoneNotice } from '@/shared/i18n/notice';
import type { PageProps } from '@/shared/lib/page-props';
import { AppShell } from '@/widgets/app-shell';
import { loginView } from '../model/state';
import { LoginProviders } from './LoginProviders';

/** 언어 고르기: 주소 접두로 이동한다(ADR-0060 결정 3) */
const LOCALES = [
  { lang: 'en', label: 'English' },
  { lang: 'ja', label: '日本語' },
  { lang: 'zh', label: '中文' },
] as const;

export async function LoginPage({ searchParams, locale }: PageProps & { locale?: Locale }) {
  const sp = await searchParams;
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = loginView(sp);
  const notice = await domesticPhoneNotice(locale);
  const current = locale ?? 'ko';

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

          <DomesticPhoneNotice text={notice} lang={locale} className="text-center" />
          <LoginProviders next={v.next} down={v.down} />

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
              <a className={current === 'ko' ? 'fw-b' : undefined} href="/login" aria-current={current === 'ko' ? 'true' : undefined} style={{ color: 'inherit' }}>
                한국어
              </a>
              {LOCALES.map((l) => (
                <a
                  key={l.lang}
                  className={current === l.lang ? 'fw-b' : undefined}
                  href={localePath(l.lang, '/login')}
                  lang={l.lang}
                  hrefLang={l.lang}
                  aria-current={current === l.lang ? 'true' : undefined}
                  style={{ color: 'inherit' }}
                >
                  {l.label}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
