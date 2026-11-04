// SCR-006 본인확인 흐름(d5 §5.6, d3 SCR-006 행, 캔버스 보드 SCR-006-m·t·d를 한 페이지 반응형으로 합쳤다).
// 이 경로(/verify/return)의 실제 화면은 '복귀 화면' 하나다: 기관이 새 창 대신 페이지 이동으로 결과를 돌려줄 때 셸 머리만 두고 진행 표시를 보인다.
// 나머지 상태는 보드처럼 부르는 화면(공연 상세 · 마이 티켓 부스 재발급 · 추가 검증)을 그리고 그 위에 기관 창·결과 대화상자를 연다.
// 부르는 화면의 [휴대폰 본인확인]은 실제로 눌러 볼 수 있다(@/features/identity-verify). 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { headers } from 'next/headers';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { Stepper } from '@peaket/ds/Stepper';
import { ME, type MeSummary } from '@/entities/me';
import { DEMO_EVENT_ID, eventHref, getPerformance, listPerformances, type Performance } from '@/entities/performance';
import { getProduction, ProductionPoster, type Production } from '@/entities/production';
import { DEMO_TICKET_ID, getTicket } from '@/entities/ticket';
import { getVenue } from '@/entities/venue';
import { VERIFY_PURPOSE_TEXT, VerifyFlowProvider, VerifyShow, VerifyTrigger, VerifyWaitingStatus } from '@/features/identity-verify';
import { decodeAgencyFields, RETURN_HEADER } from '@/features/identity-verify/server/return-post';
import { OpenAlertToggle } from '@/features/open-alert';
import { queueRoomHref } from '@/shared/config/origins';
import { SCR006_STATES } from '@/shared/config/screens.account';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { verifyView } from '../model/state';
import { VerifyReturnLive } from './VerifyReturnLive';

/** 데스크톱 보드 머리의 '새 사용자'(가입 직후 본인확인 전 팬) */
const NEW_FAN: MeSummary = { ...ME, id: 'fan-new', name: '새 사용자', avatarText: '새', verified: false, likedProductionIds: [], openAlertProductionIds: [] };

export async function VerifyReturnPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  // 이 경로로 들어오는 경우는 복귀 화면이므로 기본 상태를 '복귀 화면'으로 둔다(보드의 기본 '기관 응답 대기'는 부르는 화면 위 상태라서, 추천안)
  const state = resolvePreviewState(sp, SCR006_STATES, '복귀 화면');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = verifyView(state);
  const switcher = <PreviewSwitcher path="/verify/return" states={SCR006_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />;

  const production = getProduction('prd-lumen')!;
  const perf = getPerformance(DEMO_EVENT_ID)!;
  const venueName = getVenue(production.venueId)?.name ?? '';
  const when = `${perf.label} · ${venueName}`;

  if (v.caller === 'return') {
    // 상태 미리보기(?state=)가 아니면 실제 복귀 화면이다: 서버 처리기(apps/web/proxy.ts)가 넘긴 기관 값을 스크립트에 싣는다.
    // 값은 React가 화면 데이터로 직렬화한다(`</script>`·U+2028 등 이스케이프, ASVS v5.0.0-1.2.3). 저장·로그하지 않는다
    const live = sp.state === undefined;
    const posted = live ? decodeAgencyFields((await headers()).get(RETURN_HEADER)) : null;
    return (
      // 복귀 화면은 로고만 있는 머리, 바닥글 없음(보드 SCR-006 '복귀 화면')
      <AppShell variant="minimal" dark={dark} footer={false}>
        {live ? <VerifyReturnLive posted={posted} /> : null}
        <main className="page-main" id="main" tabIndex={-1}>
          <div className="center px-8 py-[120px] md:py-[160px]" style={{ flex: 1 }}>
            <h1 className="sr-only">본인확인 결과 확인</h1>
            <div className="col w-full max-w-[280px] md:max-w-[320px] lg:max-w-[360px]" role="status" style={{ gap: 16, alignItems: 'center', textAlign: 'center' }}>
              <div className="progress indet" aria-hidden="true">
                <span />
              </div>
              <p className="t-md fw-b">본인확인 결과를 확인하는 중입니다</p>
            </div>
          </div>
        </main>
        {switcher}
      </AppShell>
    );
  }

  if (v.caller === 'reverify') {
    return (
      <AppShell
        variant="focus"
        dark={dark}
        focus={{ title: production.title, subtitle: when, closeHref: eventHref(perf.id), closeLabel: '닫고 공연 상세로 가기(대기는 유지됩니다)' }}
      >
        <VerifyFlowProvider purpose="reverify" initial={v.initial}>
          <main className="page-main" id="main" tabIndex={-1}>
            <div className="col mx-auto w-full px-4 pt-6 pb-10 md:max-w-[608px] md:px-6 md:pt-8 md:pb-12 lg:max-w-[560px] lg:px-8 lg:pt-12 lg:pb-16" style={{ gap: 16 }}>
              <h1 className="t-xl lg:text-[32px] lg:leading-[42px]">추가 검증</h1>
              {/* 보드의 좁은 단계 줄(간격 4, 선 8) */}
              <Stepper
                label="검증 단계"
                steps={['안내', '사람 확인', '본인확인', '완료']}
                current={2}
                className="[&_.step]:gap-1 [&_.step-line]:min-w-2 [&_.step-line]:basis-2"
                style={{ gap: 4 }}
              />
              <p className="t-sm" id="vf-purpose-rev">
                {VERIFY_PURPOSE_TEXT.reverify}
              </p>
              <VerifyTrigger className="btn btn-primary btn-lg btn-block lg:w-auto lg:min-w-[280px] lg:self-start" describedBy="vf-purpose-rev">
                <i className="ic ic-phone" aria-hidden="true" />
                휴대폰 본인확인 다시 하기
              </VerifyTrigger>
              <VerifyWaitingStatus />
            </div>
          </main>
        </VerifyFlowProvider>
        {switcher}
      </AppShell>
    );
  }

  if (v.caller === 'booth') {
    const ticket = getTicket(DEMO_TICKET_ID)!;
    const seat = ticket.seatLabel.replace(/^[^·]+·\s*/, '');
    return (
      <AppShell dark={dark} user={ME}>
        <VerifyFlowProvider purpose="booth" initial={v.initial}>
          <main className="page-main" id="main" tabIndex={-1}>
            <div
              className="col mx-auto w-full px-4 pt-5 pb-8 md:max-w-[608px] md:px-6 md:pt-8 md:pb-12 lg:max-w-[704px] lg:px-8 lg:pt-10 lg:pb-14"
              style={{ gap: 16 }}
            >
              <h1 className="t-xl lg:text-[32px] lg:leading-[42px]">마이 티켓</h1>
              <article className="card col px-4 py-4 md:px-5 md:py-[18px]" style={{ gap: 6 }}>
                <strong className="t-md fw-b">{production.title}</strong>
                <span className="t-sm muted">{when}</span>
                <span className="t-sm">{seat} · 입장 게이트 동문</span>
              </article>
              <div className="banner banner-warning">
                <i className="ic ic-alert" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">이 휴대폰에서 티켓을 다시 받아야 합니다</span>
                  입장이 시작되어 온라인으로는 다시 받을 수 없습니다. 현장 부스에서 다시 받을 수 있습니다.
                </div>
              </div>
              <VerifyShow when="consented">
                <Stepper label="부스 재발급 단계" steps={['동의', '본인확인', '부스 코드']} current={1} className="gap-1.5 md:gap-2" />
                <p className="t-sm" id="vf-purpose-booth">
                  {VERIFY_PURPOSE_TEXT.booth}
                </p>
                <VerifyTrigger className="btn btn-primary btn-lg btn-block lg:w-auto lg:min-w-[280px] lg:self-start" describedBy="vf-purpose-booth">
                  <i className="ic ic-phone" aria-hidden="true" />
                  휴대폰 본인확인
                </VerifyTrigger>
                <VerifyWaitingStatus />
              </VerifyShow>
              <VerifyShow when="needConsent">
                <Stepper label="부스 재발급 단계" steps={['동의', '본인확인', '부스 코드']} current={0} className="gap-1.5 md:gap-2" />
                <VerifyTrigger
                  action="consent"
                  className="btn btn-secondary btn-lg btn-block lg:w-auto lg:min-w-[280px] lg:self-start"
                  ariaLabel={`${seat} 부스 재발급 요청`}
                >
                  부스 재발급 요청
                </VerifyTrigger>
              </VerifyShow>
            </div>
          </main>
        </VerifyFlowProvider>
        {switcher}
      </AppShell>
    );
  }

  return (
    <AppShell dark={dark} user={NEW_FAN}>
      <VerifyFlowProvider purpose="first" initial={v.initial}>
        <DetailCaller production={production} perf={perf} when={when} venueName={venueName} />
      </VerifyFlowProvider>
      {switcher}
    </AppShell>
  );
}

/** 복귀 화면의 셸: 머리에 로고만 둔다(d5 §5.6 '셸 머리만'). 일반 셸(AppShell)에 머리만 쓰는 변형이 없어 키트 .wh 마크업을 그대로 낸다 */
const TAB_ITEMS = [
  { id: 'sec-info', label: '공연 정보' },
  { id: 'sec-detail', label: '상세정보' },
  { id: 'sec-cond', label: '판매 조건' },
  { id: 'sec-venue', label: '장소' },
  { id: 'sec-review', label: '후기' },
];

/** 부르는 화면: 공연 상세(SCR-002)의 머리·바로가기 탭·공연 정보 + 휴대폰·태블릿 아래 띠 / 데스크톱 오른쪽 예매 패널 */
function DetailCaller({ production, perf, when, venueName }: { production: Production; perf: Performance; when: string; venueName: string }) {
  const rounds = listPerformances(production.id);
  const detailHref = eventHref(perf.id);
  return (
    <>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="mx-auto w-full max-w-[1280px] lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:px-8 lg:pt-8 lg:pb-12">
          <div className="col min-w-0 lg:col-span-8">
            <div className="row gap-3 p-4 md:gap-5 md:p-6 lg:gap-6 lg:px-0 lg:pt-0 lg:pb-7">
              <ProductionPoster
                art={production.poster.art}
                size="sm"
                title={production.poster.short}
                label={`${production.title} 포스터`}
                className="w-16 flex-none md:w-24 lg:w-[120px]"
              />
              <div className="col grow gap-0.5 md:gap-1 lg:gap-1.5">
                <div className="row wrap hidden lg:flex" style={{ gap: 6 }}>
                  <span className="badge badge-primary">하이브리드</span>
                  <span className="badge">좌석 직접 선택</span>
                </div>
                <h1 className="t-lg md:text-2xl md:leading-8 lg:text-[32px] lg:leading-[42px]">{production.title}</h1>
                <p className="t-sm muted md:text-base md:leading-[22px] lg:hidden">{when}</p>
                <p className="t-md muted hidden lg:block">
                  {venueName} · {production.durationText} · {production.ageText}
                </p>
              </div>
            </div>
            <nav className="tabs tabs-scroll relative px-2 md:px-4 lg:px-0" aria-label="섹션 바로가기">
              {TAB_ITEMS.map((t, i) =>
                i === 0 ? (
                  <a key={t.id} className="tab is-active max-md:min-h-[38px] max-md:px-2.5 max-md:text-sm" href="#sec-info" aria-current="true">
                    {t.label}
                  </a>
                ) : (
                  <Link key={t.id} className="tab max-md:min-h-[38px] max-md:px-2.5 max-md:text-sm" href={`${detailHref}#${t.id}`}>
                    {t.label}
                  </Link>
                ),
              )}
            </nav>
            <section className="col gap-4 px-4 pt-6 pb-7 md:px-6 md:py-7 lg:px-0 lg:py-9" id="sec-info" aria-labelledby="h-info">
              <h2 className="t-lg" id="h-info">
                공연 정보
              </h2>
              <VerifyShow when="pending">
                <div className="banner banner-warning">
                  <i className="ic ic-alert" aria-hidden="true" />
                  <div className="banner-body col" style={{ gap: 8 }}>
                    <span className="banner-title">본인확인이 필요합니다</span>
                    <p id="vf-purpose">{VERIFY_PURPOSE_TEXT.first}</p>
                    <VerifyTrigger className="btn btn-outline btn-sm" describedBy="vf-purpose" style={{ alignSelf: 'flex-start' }}>
                      <i className="ic ic-phone" aria-hidden="true" />
                      휴대폰 본인확인
                    </VerifyTrigger>
                  </div>
                </div>
              </VerifyShow>
              <VerifyShow when="done">
                <div className="col" style={{ gap: 4 }}>
                  <div className="row" style={{ gap: 10 }}>
                    <span className="t-sm fw-b">본인확인</span>
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      완료
                    </span>
                  </div>
                  <p className="t-sm muted">{VERIFY_PURPOSE_TEXT.first}</p>
                </div>
              </VerifyShow>
              <div className="banner banner-info">
                <i className="ic ic-info" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">정렬 방식 · 하이브리드</span>
                  오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 그 뒤에 도착 순으로 섭니다.
                </div>
              </div>
            </section>
          </div>

          <aside className="sticky top-6 hidden lg:col-span-4 lg:block" aria-label="회차와 예매">
            <div className="card col" style={{ padding: 20, gap: 18, boxShadow: 'var(--shadow-sm)' }}>
              <div className="col" style={{ gap: 10 }}>
                <h2 className="eyebrow" id="h-round">
                  회차
                </h2>
                <nav aria-labelledby="h-round">
                  <ul className="row wrap" style={{ gap: 8 }}>
                    {rounds.map((r) => (
                      <li key={r.id}>
                        <Link className={cx('chip', r.id === perf.id && 'is-selected')} href={eventHref(r.id)} aria-current={r.id === perf.id ? 'page' : undefined}>
                          {r.label} <span className="badge badge-primary">오픈 예정</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
              <div className="divider" />
              <div className="col" style={{ gap: 4 }}>
                <h2 className="eyebrow">오픈</h2>
                <p className="t-md">
                  <span className="num">{production.openText}</span> KST · 로비 <span className="num">{production.lobbyText}</span>부터
                </p>
              </div>
              <div className="divider" />
              <VerifyShow when="pending">
                <div className="col" style={{ gap: 8 }}>
                  <VerifyWaitingStatus fallback={<p className="t-sm muted">{VERIFY_PURPOSE_TEXT.first}</p>} />
                  <OpenAlertToggle title={production.title} variant="button" kind="open" className="btn-block" />
                  <VerifyTrigger className="btn btn-primary btn-lg btn-block" describedBy="vf-purpose">
                    <i className="ic ic-phone" aria-hidden="true" />
                    휴대폰 본인확인
                  </VerifyTrigger>
                </div>
              </VerifyShow>
              <VerifyShow when="done">
                <div className="col" style={{ gap: 8 }}>
                  <OpenAlertToggle title={production.title} variant="button" kind="open" className="btn-block" />
                  <a className="btn btn-primary btn-lg btn-block" href={queueRoomHref(perf.id)}>
                    로비 입장
                  </a>
                </div>
              </VerifyShow>
            </div>
          </aside>
        </div>
      </main>

      {/* 휴대폰·태블릿 아래 고정 띠(보드 .bottom-bar). 흐름 상태를 함께 써야 해서 셸 bottomBar 대신 본문 끝에 둔다 */}
      <div className="bottom-bar sticky bottom-0 z-10 md:px-6 lg:hidden">
        <div className="w-full">
          <VerifyShow when="pending">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
              <VerifyWaitingStatus
                className="row t-sm fw-m md:grow"
                fallback={
                  <p className="t-sm muted md:grow" id="vf-purpose-bar">
                    {VERIFY_PURPOSE_TEXT.first}
                  </p>
                }
              />
              <div className="row gap-2 md:gap-3">
                <OpenAlertToggle title={production.title} variant="button" kind="open" iconOnlyBelowMd className="btn-lg" />
                <VerifyTrigger className="btn btn-primary btn-lg grow md:flex-none md:grow-0" describedBy="vf-purpose">
                  <i className="ic ic-phone" aria-hidden="true" />
                  휴대폰 본인확인
                </VerifyTrigger>
              </div>
            </div>
          </VerifyShow>
          <VerifyShow when="done">
            <div className="row gap-2 md:gap-3">
              <div className="col hidden min-w-0 grow md:flex" style={{ gap: 2 }}>
                <strong className="t-md fw-b ellipsis">{production.title}</strong>
                <span className="t-sm muted">
                  {perf.label} · 로비 {production.lobbyText}부터
                </span>
              </div>
              <OpenAlertToggle title={production.title} variant="button" kind="open" className="btn-lg" />
              <a className="btn btn-primary btn-lg grow md:min-w-[200px] md:grow-0" href={queueRoomHref(perf.id)}>
                로비 입장
              </a>
            </div>
          </VerifyShow>
        </div>
      </div>
    </>
  );
}
