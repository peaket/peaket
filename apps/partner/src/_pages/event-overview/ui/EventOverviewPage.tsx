// SCR-063 공연 개요(회차 허브, /events/[id]). 보드 SCR-063-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.3, §3.9).
// 휴대폰: 세로 진행 단계 · 회차 카드 · 변경 취소와 '고쳐서 다시 요청'은 안내 카드 / 태블릿: 7칸 진행 단계 · 가로 스크롤 회차 표 · 바로가기 2열 /
// 데스크톱: 가로 진행 단계 · 회차 8열 + 바로가기 4열.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SELLER_FIELDS, stellaOrg } from '@/entities/partner-org';
import { ADMIN_ONLY_REASON } from '@/entities/partner-user';
import { QUEUE_MODE_LABEL, requireProduction, type Production } from '@/entities/production';
import { getVenue } from '@/entities/venue';
import { routes } from '@/shared/config/routes';
import { OVERVIEW_STATES } from '@/shared/config/states/scr063';
import { readParam, readPreview, type RouteProps } from '@/shared/lib/preview';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';

type OverviewState = (typeof OVERVIEW_STATES)[number];
/** 화면 변형: 기본 · 재승인 대기(오픈 전) · 반려 · 재승인 대기(판매 계속) */
type Variant = 'base' | 're' | 'rej' | 'rev';

function variantOf(state: OverviewState, explicit: boolean, p: Production): Variant {
  if (state === '재승인 대기(오픈 전)') return 're';
  if (state === '반려') return 'rej';
  if (state === '재승인 대기(판매 계속)' || state === '실무자 보기') return 'rev';
  // 상태를 고르지 않았으면 그 공연의 판매 승인 상태를 따른다(목업 공연마다 다르게 보이도록)
  if (!explicit && (p.review === 'REJECTED' || p.review === 'CHANGE_REJECTED')) return 'rej';
  if (!explicit && p.review === 'RESUBMITTED') return 're';
  return 'base';
}

const ROUND_STATUS: Record<Variant, { cls: string; label: string }> = {
  base: { cls: 'badge badge-primary', label: '오픈 예정' },
  re: { cls: 'badge badge-warning', label: '오픈 예약 멈춤' },
  rej: { cls: 'badge badge-outline', label: '비공개' },
  rev: { cls: 'badge badge-success', label: '판매 중' },
};

const HEAD_BADGES: Record<Variant, [string, string][]> = {
  base: [
    ['badge badge-success', '판매 승인됨'],
    ['badge badge-primary', '오픈 예정'],
  ],
  re: [
    ['badge badge-warning', '재승인 대기'],
    ['badge badge-warning', '오픈 예약 멈춤'],
  ],
  rej: [
    ['badge badge-danger', '반려'],
    ['badge badge-outline', '비공개'],
  ],
  rev: [
    ['badge badge-warning', '재승인 대기'],
    ['badge badge-success', '판매 중'],
  ],
};

export default async function EventOverviewPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const sp = await searchParams;
  const pv = readPreview(sp, OVERVIEW_STATES, '기본');
  const production = requireProduction(id);
  const v = variantOf(pv.state, readParam(sp, 'state') !== undefined, production);
  const venue = getVenue(production.venueId);
  const roundId = readParam(sp, 'round');
  const selected = production.rounds.find((r) => r.id === roundId) ?? production.rounds[0];

  const meta = [
    venue?.name,
    `회차 ${production.roundCount}개`,
    production.firstOpenAt ? `오픈 ${production.firstOpenAt}` : null,
    QUEUE_MODE_LABEL[production.queueMode],
    production.seatMode === 'PICK' ? '좌석 직접 선택' : '자동 배정',
    `1인 ${production.perPersonLimit}매`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <EventContextHeader
        production={production}
        current="overview"
        badges={HEAD_BADGES[v].map(([cls, label]) => (
          <span key={label} className={cls}>
            {label}
          </span>
        ))}
        meta={meta}
      />

      <StateBanner v={v} production={production} isMember={pv.isMember} />

      <Progress v={v} production={production} />

      <div className="grid-12 max-lg:flex max-lg:flex-col max-lg:gap-5" style={{ rowGap: 20, alignItems: 'start' }}>
        <Rounds v={v} production={production} selectedId={selected?.id} venueName={venue?.name ?? ''} />
        <Shortcuts production={production} selectedLabel={selected?.startsAt} />
      </div>

      {(v === 'base' || v === 'rej') && (
        <div className="banner banner-info">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">승인 뒤 가격·회차·좌석 등급·좌석맵·판매 정책을 바꾸면 다시 판매 승인을 받고, 오픈 전이면 오픈 예약이 멈춥니다</div>
        </div>
      )}

      <SellerNotice missingReportNo={v === 'rej'} />

      <PreviewStateSwitcher path={routes.event(id)} states={OVERVIEW_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}

/* ---------- 상태 배너 ---------- */

function StateBanner({ v, production, isMember }: { v: Variant; production: Production; isMember: boolean }) {
  const edit = routes.eventTab(production.id, 'edit');
  if (v === 're')
    return (
      <div className="banner banner-warning max-md:flex-wrap" role="status">
        <i className="ic ic-alert" aria-hidden="true" />
        <div className="banner-body max-md:basis-[calc(100%-30px)]">
          <span className="banner-title">다시 판매 승인을 받는 중입니다 · 오픈 예약이 멈췄습니다</span>
          승인 뒤 가격과 회차를 바꿔 PEAKET 운영자가 다시 확인합니다. 다시 승인될 때까지 오픈 예약이 멈춥니다. 바뀐 항목: 가격, 회차
        </div>
        <Link className="btn btn-outline btn-sm max-md:ml-[30px]" href={`${edit}?state=${encodeURIComponent('재승인 대기')}`} style={{ flex: 'none' }}>
          바뀐 항목 보기
        </Link>
      </div>
    );
  if (v === 'rej')
    return (
      <>
        <div className="banner banner-danger max-md:flex-wrap" role="status">
          <i className="ic ic-x-circle" aria-hidden="true" />
          <div className="banner-body max-md:basis-[calc(100%-30px)]">
            <span className="banner-title">판매 승인이 반려되었습니다</span>
            사유: {production.reviewNote ?? '통신판매업 신고번호 누락'} · 10/12(월) 11:05 KST 반려. 고쳐서 다시 요청하면 PEAKET 운영자가 다시 확인합니다.
          </div>
          <Link className="btn btn-primary btn-sm max-md:hidden" href={edit} style={{ flex: 'none' }}>
            고쳐서 다시 요청
          </Link>
        </div>
        <BigScreenNotice title="'고쳐서 다시 요청'은 태블릿이나 데스크톱에서 합니다" path={edit} />
      </>
    );
  if (v === 'rev')
    return (
      <>
        <div className="banner banner-info md:flex-wrap" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body md:max-lg:basis-[400px]">
            <span className="banner-title">재승인 대기 · 바꾼 항목: 가격</span>
            공개 중인 내용과 판매는 승인될 때까지 그대로입니다. 이미 판 표의 가격은 바뀌지 않습니다.
          </div>
          <div className="col max-md:hidden" style={{ gap: 4, alignItems: 'flex-end', marginLeft: 'auto', flex: 'none' }}>
            {isMember ? (
              <>
                <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="rv-cancel-role">
                  변경 취소
                </button>
                <span className="row t-xs tx-warning" id="rv-cancel-role" style={{ gap: 4 }}>
                  <i className="ic ic-lock ic-14" aria-hidden="true" />
                  {ADMIN_ONLY_REASON}
                </span>
              </>
            ) : (
              <>
                <button className="btn btn-outline btn-sm" type="button" aria-describedby="rv-cancel-h">
                  변경 취소
                </button>
                <span className="t-xs muted" id="rv-cancel-h">
                  파트너 관리자 · 마지막 승인 내용으로 돌아갑니다
                </span>
              </>
            )}
          </div>
        </div>
        <BigScreenNotice
          title="'변경 취소'는 태블릿이나 데스크톱에서 합니다"
          body="파트너 관리자가 하고, 마지막 승인 내용으로 돌아갑니다. 휴대폰에서는 볼 수만 있습니다"
        />
      </>
    );
  return null;
}

/* ---------- 진행 단계 ---------- */

interface Step {
  label: string;
  meta: string;
  tone?: 'warning' | 'danger';
  /** 같은 칸 둘째 줄(재승인 대기(판매 계속)의 판매 승인) */
  extra?: { text: string; tone: 'warning' };
}

function stepsOf(v: Variant, p: Production): { steps: Step[]; current: number } {
  const first = p.rounds[0];
  const doors = first ? `${first.startsAt.split(' ')[0]} ${first.doorsAt}` : '회차마다';
  const open = p.firstOpenAt ?? '오픈 일시 미정';
  const approved = `${p.approvedAt ?? '10/8(목)'} 승인`;
  const settle = p.xl.settlementNote ?? '회차 종료 다음 영업일';
  const tail: Step[] = [
    { label: '입장', meta: doors },
    { label: '입장 기록 마감', meta: '회차마다' },
    { label: '정산', meta: settle },
  ];
  switch (v) {
    case 're':
      return {
        steps: [
          { label: '등록', meta: '완료' },
          { label: '판매 승인', meta: '재승인 대기', tone: 'warning' },
          { label: '오픈', meta: '예약 멈춤', tone: 'warning' },
          { label: '판매', meta: '오픈 뒤' },
          ...tail,
        ],
        current: 1,
      };
    case 'rej':
      return {
        steps: [
          { label: '등록', meta: '완료' },
          { label: '판매 승인', meta: '반려 10/12(월)', tone: 'danger' },
          { label: '오픈', meta: '승인 뒤' },
          { label: '판매', meta: '오픈 뒤' },
          ...tail,
        ],
        current: 1,
      };
    case 'rev':
      return {
        steps: [
          { label: '등록', meta: '완료' },
          { label: '판매 승인', meta: approved, extra: { text: '재승인 대기', tone: 'warning' } },
          { label: '오픈', meta: open },
          { label: '판매', meta: '판매 계속' },
          ...tail,
        ],
        current: 3,
      };
    default:
      return {
        steps: [
          { label: '등록', meta: '완료' },
          { label: '판매 승인', meta: approved },
          { label: '오픈', meta: open },
          { label: '판매', meta: '오픈 뒤' },
          ...tail,
        ],
        current: 2,
      };
  }
}

function StepMeta({ s }: { s: Step }) {
  return (
    <>
      <span className={s.tone ? `t-xs tx-${s.tone} fw-b` : 't-xs muted fw-r'}>{s.meta}</span>
      {s.extra ? <span className={`t-xs tx-${s.extra.tone} fw-b`}>{s.extra.text}</span> : null}
    </>
  );
}

function Progress({ v, production }: { v: Variant; production: Production }) {
  const { steps, current } = stepsOf(v, production);
  return (
    <section className="card col gap-3.5 p-4 md:gap-4 md:px-6 md:py-5" aria-labelledby="h-prog">
      <div className="row between max-md:flex-col max-md:items-start max-md:gap-0.5" style={{ gap: 12 }}>
        <h2 className="t-md fw-b" id="h-prog">
          진행 단계
        </h2>
        <span className="t-xs muted">읽기 전용 · 일정과 판매 승인에 따라 바뀝니다</span>
      </div>
      {/* 휴대폰 세로 · 태블릿 7칸 격자 · 데스크톱 가로(보드 SCR-063-m·t·d) */}
      <nav
        className="stepper max-md:flex-col max-md:items-stretch max-md:gap-0.5 md:max-lg:grid md:max-lg:grid-cols-7 md:max-lg:items-start md:max-lg:gap-0 lg:items-start"
        aria-label="공연 진행 단계"
      >
        {steps.map((s, i) => {
          const done = i < current;
          const cur = i === current;
          const last = i === steps.length - 1;
          return (
            <StepItem key={s.label} s={s} i={i} done={done} cur={cur} last={last} />
          );
        })}
      </nav>
    </section>
  );
}

function StepItem({ s, i, done, cur, last }: { s: Step; i: number; done: boolean; cur: boolean; last: boolean }) {
  const cls = `step${done ? ' is-done' : ''}${cur ? ' is-current' : ''}`;
  const num = done ? <i className="ic ic-check" aria-hidden="true" /> : String(i + 1);
  const lineCls = `step-line${done ? ' is-done' : ''}`;
  return (
    <>
      <span
        className={`${cls} md:max-lg:flex-col md:max-lg:items-stretch md:max-lg:gap-2 md:max-lg:whitespace-normal lg:items-start`}
        aria-current={cur ? 'step' : undefined}
      >
        <span className="row" style={{ gap: 6 }}>
          <span className="step-num">{num}</span>
          {!last && <span className={`${lineCls} hidden md:max-lg:block`} aria-hidden="true" />}
        </span>
        {/* 태블릿·데스크톱: 이름 아래 날짜 */}
        <span className="col max-md:hidden" style={{ gap: 2 }}>
          <span>{s.label}</span>
          <StepMeta s={s} />
        </span>
        {/* 휴대폰: 이름 · 날짜를 한 줄에 */}
        <span className="grow md:hidden">{s.label}</span>
        <span className="col md:hidden" style={{ alignItems: 'flex-end', gap: 2 }}>
          <StepMeta s={s} />
        </span>
      </span>
      {!last && (
        <span
          className={`${lineCls} md:max-lg:hidden max-md:ml-[11px] max-md:h-2.5 max-md:w-0.5 max-md:min-w-0.5 max-md:flex-none lg:mt-[11px]`}
          aria-hidden="true"
        />
      )}
    </>
  );
}

/* ---------- 회차 ---------- */

function RoundStatus({ v }: { v: Variant }) {
  const s = ROUND_STATUS[v];
  return <span className={s.cls}>{s.label}</span>;
}

function rateOf(v: Variant, index: number, base: number | null): string {
  if (v === 'rev') return index === 0 ? '50%' : '[잠정 판매율]';
  return base === null ? '—' : `${base}%`;
}

function RoundLinks({ production, label, size }: { production: Production; label: string; size?: 'sm' }) {
  const style = size === 'sm' ? { fontSize: 13 } : undefined;
  return (
    <>
      <Link className="link-more" href={routes.eventTab(production.id, 'staff')} style={style} aria-label={`${label} 회차 현장`}>
        현장
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
      <Link className="link-more" href={routes.eventTab(production.id, 'cancellation')} style={style} aria-label={`${label} 회차 취소`}>
        회차 취소
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </>
  );
}

function Rounds({ v, production, selectedId, venueName }: { v: Variant; production: Production; selectedId?: string; venueName: string }) {
  const rounds = production.rounds;
  const base = routes.event(production.id);
  return (
    <section className="span-8 col" style={{ gap: 12 }} aria-labelledby="h-rounds">
      <div className="section-title">
        <h2 id="h-rounds">회차</h2>
        <span className="t-sm muted">
          {production.roundCount}개 · {venueName} · {production.reentry ? '재입장 가능' : '재입장 불가'}
        </span>
      </div>
      {rounds.length === 0 ? (
        <p className="t-sm muted">회차 표는 등록 정보에서 봅니다.</p>
      ) : (
        <>
          <nav className="row wrap" style={{ gap: 8 }} aria-label="회차 고르기">
            {rounds.map((r) => (
              <Link
                key={r.id}
                className={r.id === selectedId ? 'chip is-selected' : 'chip'}
                href={`${base}?round=${r.id}`}
                aria-current={r.id === selectedId ? 'page' : undefined}
                scroll={false}
              >
                {r.startsAt}
                <RoundStatus v={v} />
              </Link>
            ))}
          </nav>

          {/* 태블릿·데스크톱: 표(태블릿은 가로 스크롤 상자) */}
          <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="회차 표" tabIndex={0}>
            <table className="table dense" style={{ minWidth: 680 }}>
              <caption className="sr-only">
                회차 {rounds.length}개의 공연 시작, 입장 시작, 종료 예정, 판매 상태, 판매율
              </caption>
              <thead>
                <tr>
                  <th scope="col">공연 시작</th>
                  <th scope="col">입장 시작</th>
                  <th scope="col">종료 예정</th>
                  <th scope="col">판매 상태</th>
                  <th scope="col" className="r">
                    판매율
                  </th>
                  <th scope="col">
                    <span className="sr-only">바로가기</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rounds.map((r, i) => (
                  <tr key={r.id} className={r.id === selectedId ? 'is-selected' : undefined}>
                    <td className="fw-b nowrap">{r.startsAt}</td>
                    <td className="num nowrap">{r.doorsAt}</td>
                    <td className="num nowrap">{r.endsAt}</td>
                    <td>
                      <RoundStatus v={v} />
                    </td>
                    <td className="r">{rateOf(v, i, r.saleRate)}</td>
                    <td>
                      <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
                        <RoundLinks production={production} label={r.startsAt.replace(' KST', '')} size="sm" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 휴대폰: 회차 카드 */}
          <ul className="col md:hidden" style={{ gap: 12 }} aria-label={`회차 ${rounds.length}개`}>
            {rounds.map((r, i) => (
              <li key={r.id}>
                <article className={r.id === selectedId ? 'card is-selected col' : 'card col'} style={{ padding: '14px 16px', gap: 10 }} aria-labelledby={`rd-${r.id}`}>
                  <div className="row between" style={{ gap: 8 }}>
                    <h3 className="t-md fw-b" id={`rd-${r.id}`}>
                      {r.startsAt}
                      {r.id === selectedId ? <span className="sr-only">(고른 회차)</span> : null}
                    </h3>
                    <RoundStatus v={v} />
                  </div>
                  <dl className="kv">
                    <dt>입장 시작</dt>
                    <dd>{r.doorsAt}</dd>
                    <dt>종료 예정</dt>
                    <dd>{r.endsAt}</dd>
                    <dt>판매율</dt>
                    <dd>{rateOf(v, i, r.saleRate)}</dd>
                  </dl>
                  <div className="row" style={{ gap: 16, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <RoundLinks production={production} label={r.startsAt.replace(' KST', '')} />
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="t-xs muted">판매율은 오픈 뒤 약 1분 늦은 잠정 집계입니다.</p>
    </section>
  );
}

/* ---------- 바로가기 ---------- */

function Shortcut({ href, icon, title, desc, primary = true }: { href: string; icon: string; title: string; desc: string; primary?: boolean }) {
  return (
    <Link className="card row px-3.5 py-3 lg:py-2.5" href={href} style={{ gap: 12, color: 'inherit' }}>
      <span className={primary ? 'state-icon is-primary' : 'state-icon'} style={{ width: 36, height: 36 }}>
        <i className={`ic ${icon}`} aria-hidden="true" style={{ width: 18, height: 18 }} />
      </span>
      <span className="col grow" style={{ gap: 2 }}>
        <span className="t-md fw-b">{title}</span>
        <span className="t-xs muted">{desc}</span>
      </span>
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );
}

function Shortcuts({ production, selectedLabel }: { production: Production; selectedLabel?: string }): ReactNode {
  const id = production.id;
  return (
    <section className="span-4 col" style={{ gap: 10 }} aria-labelledby="h-go">
      <div className="section-title">
        <h2 id="h-go">바로가기</h2>
      </div>
      {selectedLabel ? <p className="t-xs muted">고른 회차: {selectedLabel}</p> : null}
      <div className="grid gap-2.5 md:max-lg:grid-cols-2 md:max-lg:gap-3">
        <Shortcut href={routes.eventTab(id, 'live')} icon="ic-chart" title="판매 현황" desc="오픈 뒤 약 1분 늦은 잠정 집계" />
        <Shortcut href={routes.eventTab(id, 'staff')} icon="ic-scan" title="현장" desc={`스태프 ${production.xl.staff === '—' ? '초대 전' : production.xl.staff} · 기기 배치`} />
        <Shortcut href={routes.eventTab(id, 'settlement')} icon="ic-won" title="정산·명단" desc="정산서는 회차가 끝난 다음 영업일에 만듭니다" />
        <Shortcut href={routes.eventTab(id, 'cancellation')} icon="ic-ban" title="회차 취소" desc="취소·연기 요청과 판정 상태" primary={false} />
      </div>
    </section>
  );
}

/* ---------- 판매자 고지 미리보기(CMP-058 detail) ---------- */

function SellerNotice({ missingReportNo }: { missingReportNo: boolean }) {
  const seller = stellaOrg.seller;
  return (
    <section className="card col gap-3.5 p-4 md:px-6 md:py-5" aria-labelledby="h-notice">
      <div className="row between wrap" style={{ gap: '4px 8px' }}>
        <h2 className="t-md fw-b" id="h-notice">
          판매자 고지 미리보기
        </h2>
        <Link className="link-more" href={routes.settingsSeller()}>
          판매자 정보 보기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </div>
      <p className="t-xs muted">팬이 공연 상세에서 예매하기 전에 보는 모습입니다. 고지 문장은 바꿀 수 없고, 7항목은 판매자 정보에서 가져옵니다.</p>
      <div className="card-flat col p-4 md:p-5" style={{ gap: 12 }}>
        <section className="col" style={{ gap: 12 }} aria-labelledby="h-sn">
          <h3 className="t-md fw-b" id="h-sn">
            판매자 정보
          </h3>
          <div className="banner banner-legal">
            <i className="ic ic-scale" aria-hidden="true" />
            <div className="banner-body">
              <span className="legal-tag">법정 고지</span>
              판매자: {seller.companyName}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고,
              예매 취소와 환불은 PEAKET이 처리합니다
            </div>
          </div>
          <dl className="t-sm grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8">
            {SELLER_FIELDS.map((f) => (
              <div key={f.key} className="row between" style={{ gap: 12, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <dt className="muted">{f.label}</dt>
                <dd className="fw-m">
                  {f.key === 'mailOrderNo' && missingReportNo ? (
                    <span className="tx-danger row" style={{ gap: 4 }}>
                      <i className="ic ic-alert-circle ic-16" aria-hidden="true" />
                      입력 안 됨
                    </span>
                  ) : (
                    seller[f.key]
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </section>
  );
}
