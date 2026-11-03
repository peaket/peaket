// SCR-010 좌석 선택(d5 §5.10, d3 SCR-010 행, 캔버스 보드 SCR-010-m·t·d를 한 페이지 반응형으로 합쳤다). 집중 셸, 주소의 eventId는 회차다.
// 휴대폰: 배너 → 범례(구역 또는 좌석 상태) → 등급 칩·연석 찾기 → 좌석맵(근사) → 목록 보기·자동 배정 → 아래 바텀 시트(선택 요약).
// 태블릿(md): 같은 순서, 좌석맵 560 높이, 요약은 아래 띠. 데스크톱(lg): 좌석맵 8열 + 오른쪽 패널 4열(범례·선택 요약·타이머·버튼).
// 자동 배정(AUTO) 상태는 보드처럼 자동 배정 공연(E-2 가을 야외 페스티벌) 머리를 빌린다. 좌석맵은 보드 그림의 근사다(실제 Canvas·실시간 없음).
import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { PriceTierLegend } from '@peaket/ds/PriceTierLegend';
import { SeatLegend, SeatSwatch, type SeatStatus } from '@peaket/ds/SeatStatusBadge';
import { DEMO_AUTO_ASSIGN, DEMO_HOLD } from '@/entities/hold';
import { getPerformance } from '@/entities/performance';
import { formatWon, getProduction } from '@/entities/production';
import { GRADE_FILL, SEAT_TIERS } from '@/entities/seat';
import { getVenue } from '@/entities/venue';
import { SCR010_STATES, type Scr010State } from '@/shared/config/screens.booking';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { seatsView, zoomTargets, type SeatsView } from '../model/view';
import { GradeChips, IdleDialog, NavButton, QtyStepper } from './SeatControls';
import { SeatMap } from './SeatMap';
import { SeatTreeList } from './SeatTreeList';
import { SummaryBar, SummaryCard, SummarySheet, type SummaryLinks } from './Summary';

type Props = PageProps<{ eventId: string }>;

/** 자동 배정 화면이 빌리는 자동 배정 공연 회차(E-2) */
const AUTO_DEMO_EVENT_ID = 'evt-fest-1107';

function load(eventId: string) {
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  if (!perf || !production || !venue) return null;
  return { perf, production, venue };
}

const BANNER: Record<NonNullable<SeatsView['banner']>, { tone: 'warning' | 'danger' | 'announce'; icon: 'alert' | 'wifi-off' | 'pause' | 'calendar' | 'clock' | 'megaphone'; role: 'status' | 'alert'; title?: string; text: string }> = {
  degraded: { tone: 'warning', icon: 'alert', role: 'status', text: '실시간 반영이 느려졌습니다' },
  reconnecting: { tone: 'warning', icon: 'wifi-off', role: 'status', text: '실시간 연결 복구 중' },
  'sale-paused': { tone: 'danger', icon: 'pause', role: 'alert', title: '판매가 잠시 멈췄습니다.', text: '고른 좌석은 홀드 시간 동안 유지됩니다' },
  'sale-ended': { tone: 'warning', icon: 'calendar', role: 'alert', text: '판매 시간이 끝나 좌석을 새로 고를 수 없습니다. 이미 고른 좌석은 남은 시간 안에 결제할 수 있습니다' },
  'hold-expired': { tone: 'warning', icon: 'clock', role: 'alert', text: '홀드 시간이 끝나 좌석이 풀렸습니다. 요금은 청구되지 않습니다' },
  // 운영 공지 그림 예는 §7.16 초안 템플릿 payment-confirm-delay(d5 §5.10 상태 표)
  notice: { tone: 'announce', icon: 'megaphone', role: 'status', title: '운영 공지', text: '결제 확인이 평소보다 늦어지고 있습니다. 결과는 확인되는 대로 보여 드리며, 중복 청구는 발생하지 않습니다.' },
};

/** 구역의 남은 좌석 무늬(많음 · 적음 · 매진) */
const ZONE_SWATCH: Record<'많음' | '적음' | '매진', CSSProperties> = {
  많음: { background: 'var(--heat-2)' },
  적음: { background: 'repeating-linear-gradient(45deg,var(--heat-2) 0 3px,var(--surface) 3px 5px)' },
  매진: {
    backgroundColor: 'var(--fill-weak-strong)',
    backgroundImage:
      'repeating-linear-gradient(45deg,var(--text-muted) 0 1px,transparent 1px 4px),repeating-linear-gradient(-45deg,var(--text-muted) 0 1px,transparent 1px 4px)',
  },
};

function Swatch({ style, size }: { style: CSSProperties; size: 'sm' | 'md' }) {
  const box: CSSProperties = size === 'md' ? { width: 16, height: 12, borderRadius: 3 } : { width: 14, height: 10, borderRadius: 2 };
  return <span aria-hidden="true" style={{ display: 'inline-block', ...box, ...style }} />;
}

function ZoneLevelItems({ size }: { size: 'sm' | 'md' }) {
  return (
    <>
      {(['많음', '적음', '매진'] as const).map((k) => (
        <li key={k} className="legend-item">
          <Swatch style={ZONE_SWATCH[k]} size={size} />
          {k}
        </li>
      ))}
    </>
  );
}

const SEAT_LEGEND: readonly SeatStatus[] = ['available', 'held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'];

/** 휴대폰·태블릿 범례(지도 위). 전체 배치는 등급 색 + 구역의 남은 좌석, 확대하면 좌석 상태 + 등급 글자 */
function InlineLegend({ view }: { view: SeatsView }) {
  if (view.legend === 'zone')
    return (
      <div className="col gap-1.5 px-4 max-lg:order-first md:flex-row md:flex-wrap md:items-center md:gap-x-7 md:gap-y-2 md:px-0 lg:hidden">
        <PriceTierLegend tiers={SEAT_TIERS} />
        <div className="row wrap gap-x-3 gap-y-1 md:gap-y-1.5">
          <span className="t-xs fw-b">구역의 남은 좌석</span>
          <ul className="legend" aria-label="구역의 남은 좌석" style={{ gap: '4px 12px' }}>
            <ZoneLevelItems size="sm" />
          </ul>
        </div>
      </div>
    );
  return (
    <div className="col gap-2 px-4 max-lg:order-first md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-x-6 md:px-0 lg:hidden">
      <SeatLegend statuses={view.recent ? [...SEAT_LEGEND, 'recently-released'] : SEAT_LEGEND} />
      <PriceTierLegend tiers={SEAT_TIERS} variant="plain" />
    </div>
  );
}

/** 데스크톱 오른쪽 패널의 범례 카드 */
function LegendCard({ recent }: { recent: boolean }) {
  return (
    <section className="card pad col" style={{ gap: 12 }} aria-labelledby="tier-h">
      <h2 className="t-sm fw-b" id="tier-h">
        등급과 가격
      </h2>
      <ul className="col t-sm" style={{ gap: 6 }} aria-labelledby="tier-h">
        {SEAT_TIERS.map((t) => (
          <li key={t.name} className="row between">
            <span className="row" style={{ gap: 8 }}>
              <Swatch size="md" style={{ background: GRADE_FILL[t.name], ...(t.name === 'A석' ? { boxShadow: 'inset 0 0 0 1px var(--border)' } : null) }} />
              <span className="fw-b">{t.name}</span>
            </span>
            <span className="num muted">{formatWon(t.price)}</span>
          </li>
        ))}
      </ul>
      <div className="divider" />
      <h2 className="t-sm fw-b" id="zone-h">
        구역의 남은 좌석 <span className="t-xs muted fw-r">전체 배치</span>
      </h2>
      <ul className="legend" aria-labelledby="zone-h" style={{ gap: '6px 14px' }}>
        <ZoneLevelItems size="md" />
      </ul>
      <div className="divider" />
      <h2 className="t-sm fw-b" id="lg-h">
        좌석 상태 <span className="t-xs muted fw-r">확대했을 때</span>
      </h2>
      <ul className="legend" aria-labelledby="lg-h" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '8px 12px' }}>
        {(recent ? [...SEAT_LEGEND, 'recently-released' as const] : SEAT_LEGEND).map((s) => (
          <li key={s} className="legend-item">
            <SeatSwatch status={s} size="md" round />
            {s === 'available'
              ? '예매 가능'
              : s === 'held-by-others'
                ? '다른 분 선택'
                : s === 'mine'
                  ? '내 선택'
                  : s === 'sold'
                    ? '판매됨·선택 불가'
                    : s === 'unavailable'
                      ? '판매 제외'
                      : s === 'wheelchair'
                        ? '휠체어석'
                        : '방금 놓은 좌석'}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AutoArea({ view, checkoutHref, toState }: { view: SeatsView; checkoutHref: string; toState: (s: Scr010State) => string }) {
  const a = DEMO_AUTO_ASSIGN;
  const card = 'card pad-lg col w-full md:max-w-[480px] lg:max-w-[520px]';
  return (
    <div className="col px-4 pt-5 pb-8 md:items-center md:px-0 md:py-10 lg:py-12">
      <h1 className="sr-only">좌석 선택</h1>
      {view.auto === 'result' ? (
        <section className={card} style={{ gap: 18 }} aria-labelledby="as-h" aria-live="polite">
          <div className="row between">
            <h2 className="t-lg" id="as-h">
              배정 결과
            </h2>
            <span className="badge badge-primary">{a.type}</span>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="t-sm muted">{a.grade}</span>
            <strong className="t-xl">{a.seatsText}</strong>
          </div>
          <dl className="kv">
            <dt>결제 금액</dt>
            <dd className="kv-total num">{formatWon(a.amount)}</dd>
            <dt>남은 홀드 시간</dt>
            <dd className="num">{view.hold?.text}</dd>
          </dl>
          <div className="col gap-[18px] lg:flex-row-reverse lg:gap-2">
            <Link className="btn btn-primary btn-lg w-full lg:w-auto lg:flex-1" href={checkoutHref}>
              결제하기
            </Link>
            {/* [반납]은 배정 좌석을 풀고 수동 선택으로 간다(d5 §5.10 ⑦) */}
            <button className="btn btn-secondary btn-lg w-full lg:w-auto lg:flex-1" type="button">
              반납하고 직접 고르기
            </button>
          </div>
        </section>
      ) : null}
      {view.auto === 'assigning' ? (
        <section className={card} style={{ gap: 16, alignItems: 'center', textAlign: 'center' }} aria-labelledby="ai-h" aria-live="polite">
          <h2 className="t-lg" id="ai-h">
            배정 결과
          </h2>
          <span className="spinner tx-link" aria-hidden="true" style={{ width: 32, height: 32 }} />
          <p className="t-md fw-b" role="status">
            좌석을 배정하는 중
          </p>
          <p className="t-sm muted">{a.wish}</p>
        </section>
      ) : null}
      {view.auto === 'failed' || view.auto === 'wish-error' ? (
        <section className={card} style={{ gap: 16 }} aria-labelledby="am-h" aria-live="polite">
          <h2 className="t-lg" id="am-h">
            수동 선택
          </h2>
          {view.auto === 'failed' ? (
            <p className="row t-sm" role="status" style={{ gap: 8, alignItems: 'flex-start' }}>
              <i className="ic ic-alert tx-warning" aria-hidden="true" />
              <span>희망 조건에 맞는 좌석이 없습니다. 남은 등급에서 골라 주세요</span>
            </p>
          ) : (
            <p className="error-msg" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              희망 조건을 다시 골라 주세요
            </p>
          )}
          <div className="col" style={{ gap: 10 }}>
            <span className="label" id="am-tier-l">
              남은 등급
            </span>
            <div className="row" style={{ gap: 20 }} role="radiogroup" aria-labelledby="am-tier-l">
              {a.remainingGrades.map((g, i) => (
                <label key={g} className="check-row">
                  <input className="rd" type="radio" name="am-tier" value={g} defaultChecked={i === 0} />
                  {g}
                </label>
              ))}
            </div>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <div className="row between">
              <span className="label" id="am-qty-l">
                매수
              </span>
              <QtyStepper initial={a.quantity} max={a.perPerson} labelledBy="am-qty-l" describedBy="am-qty-h" />
            </div>
            <p className="hint" id="am-qty-h">
              한 공연에서 최대 {a.perPerson}매까지 구매할 수 있습니다
            </p>
          </div>
          <NavButton href={toState('배정 중(자동 배정)')} className="btn btn-primary btn-lg btn-block">
            배정 요청
          </NavButton>
        </section>
      ) : null}
    </div>
  );
}

function GoneState({ kind }: { kind: 'ended' | 'invalid' }) {
  // 버튼 없이 넘어가는 중 스피너를 두고 SCR-008 대기열로 자동으로 옮긴다(d5 §5.10, 추천 적용 2026-10-28)
  return (
    <>
      <h1 className="sr-only">좌석 선택</h1>
      <section className="state" role="alert" style={{ padding: '96px 24px 24px' }}>
        <span className="state-icon">
          <i className={cx('ic', kind === 'ended' ? 'ic-clock' : 'ic-device')} aria-hidden="true" />
        </span>
        <h2 className="t-lg">{kind === 'ended' ? '예매 시간이 끝났습니다' : '다른 탭에서 예매가 진행 중이거나 예매 세션이 끝났습니다'}</h2>
        <span className="spinner muted" aria-hidden="true" />
      </section>
    </>
  );
}

export async function SeatsPage({ params, searchParams }: Props) {
  const { eventId } = await params;
  const d = load(eventId);
  if (!d) notFound();
  const { perf, production, venue } = d;
  const sp = await searchParams;
  // 자동 배정 공연은 지도 대신 배정 결과가 첫 화면이다(추천안: 보드 기본값 '전체 배치'는 직접 선택 공연 기준)
  const state = resolvePreviewState(sp, SCR010_STATES, production.seatMode === 'AUTO' ? '자동 배정 결과' : '전체 배치');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = seatsView(state);
  const path = `/booking/${perf.id}/seats`;
  const keep = { theme: dark ? 'dark' : undefined };
  const toState = (s: Scr010State) => previewHref(path, s, keep);

  const autoBorrow = v.auto && production.seatMode !== 'AUTO' ? load(AUTO_DEMO_EVENT_ID) : null;
  const head = autoBorrow ?? d;
  const focus = {
    title: head.production.title,
    subtitle: `${head.perf.label} · ${head.venue.name}`,
    closeHref: `/events/${head.perf.id}`,
    hold: v.hold,
    // 데스크톱 직접 선택은 오른쪽 요약 카드에 같은 타이머가 있어 머리에는 보이지 않는다(보드 SCR-010-d hdPick). 자동 배정은 머리에 둔다
    holdOnDesktop: Boolean(v.auto),
  };
  const links: SummaryLinks = {
    checkout: `/booking/${perf.id}/checkout`,
    leave: `/events/${perf.id}`,
    extend: toState('연장 뒤'),
    release: toState('방금 놓은 좌석'),
  };
  const zoom = zoomTargets(v.map);
  const banner = v.banner ? BANNER[v.banner] : null;
  const zone = { name: 'R1구역', grade: 'R석', price: 154000, gate: '동문' };

  const bottomBar =
    v.pick && v.summary ? (
      <>
        <div className="sticky bottom-0 z-10 md:hidden">
          <SummarySheet view={v} hold={DEMO_HOLD} links={links} />
        </div>
        <div className="sticky bottom-0 z-10 hidden md:block lg:hidden">
          <SummaryBar view={v} hold={DEMO_HOLD} links={links} />
        </div>
      </>
    ) : null;

  return (
    <AppShell variant="focus" dark={dark} focus={focus} bottomBar={bottomBar}>
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="col gap-3 pt-3 pb-4 md:gap-3.5 md:px-6 md:pt-4 md:pb-6 lg:mx-auto lg:w-full lg:max-w-[1280px] lg:gap-4 lg:px-8 lg:pt-6 lg:pb-8">
          {v.oneMinute ? (
            <p className="sr-only" role="status">
              홀드 남은 시간이 1분입니다
            </p>
          ) : null}
          {banner ? (
            <NoticeBanner tone={banner.tone} icon={banner.icon} role={banner.role} title={banner.title} className="mx-4 md:mx-0">
              {banner.text}
            </NoticeBanner>
          ) : null}

          {v.pick ? (
            <div className="col gap-3 md:gap-3.5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:gap-y-4">
              <section className="col gap-3 md:gap-3.5 lg:col-span-8 lg:gap-3" aria-labelledby="h-seat">
                <div className="row wrap gap-1.5 px-4 md:gap-2 md:px-0 lg:justify-between lg:gap-3">
                  <h1 className="t-xl max-lg:sr-only" id="h-seat">
                    좌석 선택
                  </h1>
                  <div className="row wrap grow gap-1.5 md:gap-2 lg:grow-0">
                    <GradeChips grades={SEAT_TIERS.map((t) => t.name)} />
                    {/* 운영 명령 9(비핵심 기능 끄기 '좌석 추천')로 꺼지면 이 버튼만 사라진다(d5 §5.10) */}
                    <button className="btn btn-secondary btn-sm ml-auto md:ml-0" type="button">
                      <i className="ic ic-users" aria-hidden="true" />
                      연석 2매 찾기
                    </button>
                  </div>
                </div>

                <InlineLegend view={v} />

                {v.map ? (
                  <div className="col" style={{ gap: 8 }}>
                    {v.map === 'seats' ? (
                      <p className="t-sm px-4 md:px-0">
                        <span className="fw-b">{zone.name}</span>{' '}
                        <span className="muted">
                          · {zone.grade} {formatWon(zone.price)} · 입장 게이트 {zone.gate}
                        </span>
                      </p>
                    ) : null}
                    <SeatMap
                      level={v.map}
                      scene={v.scene}
                      popover={v.popover}
                      lost={v.lost}
                      recent={v.recent}
                      zoom={{ zoomIn: toState(zoom.zoomIn), zoomOut: toState(zoom.zoomOut), fit: toState(zoom.fit) }}
                    />
                    {v.map === 'overview' || v.map === 'mid' ? (
                      <p className="hint px-4 text-center md:px-0">구역을 확대하면 좌석을 고를 수 있습니다</p>
                    ) : null}
                  </div>
                ) : null}

                {v.list ? (
                  <div className="col px-4 md:px-0" style={{ gap: 8 }}>
                    <p className="hint" id="sl-hint">
                      방향키로 구역·열·좌석을 옮겨 다니고, Space 키로 좌석을 고릅니다
                    </p>
                    <SeatTreeList hintId="sl-hint" />
                  </div>
                ) : null}

                <div className="row gap-2 px-4 md:px-0">
                  {v.list ? (
                    <NavButton href={toState('확대 — 좌석')} className="btn btn-outline grow md:grow-0">
                      <i className="ic ic-map" aria-hidden="true" />
                      지도로 보기
                    </NavButton>
                  ) : (
                    <NavButton href={toState('목록으로 보기')} className="btn btn-outline grow md:grow-0">
                      <i className="ic ic-list" aria-hidden="true" />
                      목록으로 보기
                    </NavButton>
                  )}
                  <NavButton href={toState('배정 중(자동 배정)')} className="btn btn-outline grow md:grow-0">
                    <i className="ic ic-bolt" aria-hidden="true" />
                    자동 좌석 배정
                  </NavButton>
                </div>
              </section>

              <aside className="hidden lg:sticky lg:top-6 lg:col-span-4 lg:flex lg:flex-col lg:gap-4" aria-label="범례와 선택 요약">
                <LegendCard recent={v.recent} />
                <SummaryCard view={v} hold={DEMO_HOLD} links={links} />
              </aside>
            </div>
          ) : null}

          {v.auto ? <AutoArea view={v} checkoutHref={`/booking/${head.perf.id}/checkout`} toState={toState} /> : null}
          {v.gone ? <GoneState kind={v.gone} /> : null}
        </div>
        {v.idle ? <IdleDialog /> : null}
      </main>
      <PreviewSwitcher path={path} states={SCR010_STATES} current={state} keep={keep} />
    </AppShell>
  );
}
