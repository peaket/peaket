// SCR-040 로그인 수단·계정 합치기(d5 §5.22, d3 SCR-040 행, 캔버스 보드 SCR-040-m·t·d를 한 페이지 반응형으로 합쳤다).
// ① 연결된 로그인 수단 목록(연결 해제) → ② [로그인 수단 추가] → ④~⑥ 계정 합치기 카드(MergePanel: ds MergeSummary + 확인 창).
// 휴대폰은 바탕 위에 쌓고(합치기 카드만 카드), md 768부터 두 구역 모두 카드, lg 1280은 왼쪽 계정 설정 메뉴(3칸) + 오른쪽 본문(9칸).
// 흡수된 세션 안내는 세션이 끝난 뒤라 셸을 로그인 전 모양으로 그린다(추천안). 상태는 ?state=, 다크는 ?theme=dark.
// API 출처가 있고 미리보기 상태가 '목록'이면 ①②③은 실제 흐름(LiveLoginMethods, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041)이다. 합치기(④)는 BOT-042.
import Link from 'next/link';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME } from '@/entities/me';
import { LINKED_PROVIDERS, MERGE_PROPOSAL, PROVIDER_NAME, type LinkedProvider } from '@/entities/provider';
import { SCR040_STATES } from '@/shared/config/screens.account';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { mergeContent, SETTINGS_MENU, SURVIVOR_PROVIDER } from '../model/content';
import { providersView } from '../model/state';
import { isLiveLoginMethods } from '@/features/login-methods';
import { LiveLoginMethods } from './LiveLoginMethods';
import { MergePanel } from './MergePanel';

const LAST_ONE_ID = 'last-w';
/** md 이상에서 카드가 되는 구역(휴대폰 보드는 카드 없이 바탕 위) */
const CARD_FROM_MD = 'md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-6 md:py-5';

export async function SettingsProvidersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR040_STATES, '목록');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = providersView(state);
  const providers = v.onlyOne ? LINKED_PROVIDERS.filter((p) => p.id === SURVIVOR_PROVIDER) : LINKED_PROVIDERS;
  const live = isLiveLoginMethods() && state === '목록';
  const loginMethod = typeof sp.loginMethod === 'string' ? sp.loginMethod : undefined;

  return (
    <AppShell dark={dark} guest={v.absorbed}>
      <main className="page-main pb-10 md:pb-12 lg:pb-16" id="main" tabIndex={-1}>
        {v.absorbed ? (
          <Absorbed />
        ) : (
          <div className="mx-auto w-full lg:grid lg:max-w-[1040px] lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:px-8 lg:pt-8">
            <SettingsSideNav />

            <div className="col min-w-0 md:gap-5 md:px-6 md:pt-5 lg:col-span-9 lg:px-0 lg:pt-0">
              <div className="col px-4 pt-3 pb-1 md:p-0" style={{ gap: 8 }}>
                <Link className="row t-sm muted lg:hidden" href="/my/settings" style={{ gap: 2, alignSelf: 'flex-start' }}>
                  <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
                  계정 설정
                </Link>
                <nav className="breadcrumb hidden lg:flex" aria-label="위치">
                  <Link href="/my/settings">계정 설정</Link>
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                  <span>로그인 수단·계정 합치기</span>
                </nav>
                <h1 className="t-xl md:text-[32px] md:leading-[42px]">로그인 수단·계정 합치기</h1>
              </div>

              {live ? <LiveLoginMethods loginMethod={loginMethod} /> : null}
              {live ? null : <section className={cx('col gap-2 px-4 pt-4', CARD_FROM_MD)} aria-labelledby="h-list">
                <div className="section-title">
                  <h2 id="h-list">연결된 로그인 수단</h2>
                </div>
                <ul className="col">
                  {providers.map((p) => (
                    <ProviderRow key={p.id} provider={p} lastOne={providers.length === 1} />
                  ))}
                </ul>
                {providers.length === 1 ? (
                  <NoticeBanner id={LAST_ONE_ID} tone="warning" className="md:mt-1">
                    마지막 로그인 수단은 해제할 수 없습니다
                  </NoticeBanner>
                ) : null}
                <div className="flex flex-col gap-2 md:mt-2 md:flex-row md:items-center md:justify-between md:gap-4">
                  <p className="t-xs muted">연결을 해제하거나 수단을 추가하기 전에 다시 로그인합니다.</p>
                  <button className="btn btn-secondary btn-block mt-2 md:mt-0 md:w-auto" type="button">
                    <i className="ic ic-plus" aria-hidden="true" />
                    로그인 수단 추가
                  </button>
                </div>
              </section>}

              {v.merge && !live ? <MergePanel initialStatus={v.merge} confirmOpen={v.confirm} content={mergeContent()} provider={SURVIVOR_PROVIDER} /> : null}
            </div>
          </div>
        )}
      </main>
      <PreviewSwitcher path="/my/settings/providers" states={SCR040_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

/** 연결된 수단 한 줄: 제공자 표시 · 처음 연결 · 최근 로그인(휴대폰 두 줄, md부터 한 줄) · [연결 해제](마지막 하나면 이유 있는 비활성) */
function ProviderRow({ provider: p, lastOne }: { provider: LinkedProvider; lastOne: boolean }) {
  const name = PROVIDER_NAME[p.id];
  return (
    <li className="li">
      <span
        className={`btn btn-${p.id}`}
        aria-hidden="true"
        style={{ width: 40, height: 40, padding: 0, ...(p.id === 'naver' ? { borderRadius: '50%' } : null) }}
      >
        <i className={`prov prov-${p.id}`} />
      </span>
      <span className="col grow" style={{ gap: 2 }}>
        <span className="li-title">{name}</span>
        <span className="li-sub md:hidden">처음 연결 {p.firstLinked}</span>
        <span className="li-sub md:hidden">최근 로그인 {p.lastLogin}</span>
        <span className="li-sub hidden md:block">
          처음 연결 {p.firstLinked} · 최근 로그인 {p.lastLogin}
        </span>
      </span>
      <button
        className="btn btn-outline btn-sm"
        type="button"
        aria-label={`${name} 연결 해제`}
        aria-disabled={lastOne ? true : undefined}
        aria-describedby={lastOne ? LAST_ONE_ID : undefined}
      >
        연결 해제
      </button>
    </li>
  );
}

/** 데스크톱(lg) 왼쪽 계정 설정 메뉴(SCR-017과 같은 메뉴, 보드 SCR-040-d) */
function SettingsSideNav() {
  return (
    <div className="col hidden lg:col-span-3 lg:flex" style={{ gap: 20 }}>
      <div className="row" style={{ gap: 12 }}>
        <span className="avatar" style={{ width: 44, height: 44, fontSize: 16 }} aria-hidden="true">
          {ME.avatarText}
        </span>
        <span className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
          <strong className="t-md fw-b">{ME.name}</strong>
          {ME.verified ? (
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              본인확인 완료
            </span>
          ) : null}
        </span>
      </div>
      <nav className="col" style={{ gap: 2 }} aria-label="계정 설정 메뉴">
        {SETTINGS_MENU.map((m) => {
          const current = 'current' in m && m.current;
          return (
            <Link key={m.label} className={cx('menu-item', current && 'is-active')} href={m.href} aria-current={current ? 'page' : undefined}>
              <i className={`ic ic-${m.icon} ic-16`} aria-hidden="true" />
              {m.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** 지금 계정이 대표 계정으로 흡수되어 세션이 끝났다(세션 종료 MERGED, 휴대폰 보드) */
function Absorbed() {
  return (
    <div className="col mx-auto w-full max-w-[400px] gap-5 px-4 pt-14 pb-6">
      <div className="state" role="alert" style={{ padding: 0 }}>
        <span className="state-icon is-warning">
          <i className="ic ic-logout" aria-hidden="true" />
        </span>
        <h1 className="t-xl">이 계정은 대표 계정으로 합쳐졌습니다</h1>
        <p className="t-md muted">대표 계정으로 다시 로그인해 주세요</p>
      </div>
      <p className="t-sm muted" style={{ textAlign: 'center' }}>
        {PROVIDER_NAME[MERGE_PROPOSAL.incoming]}로 로그인해도 대표 계정으로 들어갑니다.
      </p>
      <Link className="btn btn-primary btn-lg btn-block" href="/login">
        로그인 화면으로 가기
      </Link>
    </div>
  );
}
