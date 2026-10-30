// SCR-062 파트너 홈·공연 목록(/events). 보드 SCR-062-m·t·d·xl을 한 페이지 반응형으로 합쳤다(d5 §6.2, §3.9).
// 휴대폰: 할 일 2열 · 공연 카드 목록 · 새 공연 등록과 '고쳐서 다시 요청'은 안내 카드 / 태블릿: 할 일 2열 · 가로 스크롤 표 /
// 데스크톱: 할 일 4열 · 표 / xl 1440: 할 일 6열 · 결제사·정산·현장 스태프 칸과 결제사 거르기.
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  productions,
  SALE_REVIEW_BADGE,
  SALE_REVIEW_LABEL,
  SALE_STATUS_BADGE,
  SALE_STATUS_LABEL,
  type Production,
} from '@/entities/production';
import { PARTNER_SUPPORT_HREF as SUPPORT_HREF, routes } from '@/shared/config/routes';
import { HOME_STATES } from '@/shared/config/states/scr062';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';


type HomeState = (typeof HOME_STATES)[number];

export default async function PartnerHomePage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, HOME_STATES, '목록');
  const st: HomeState = pv.state;
  const reReq = st === '재승인 대기(판매 계속)';

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>공연 관리</h1>
          <p className="t-sm muted">등록한 공연의 판매 승인 상태와 판매 상태를 봅니다. 시각은 모두 KST입니다.</p>
        </div>
      </div>

      {st === '빈 화면' ? (
        <EmptyState />
      ) : st === '로딩' ? (
        <LoadingState />
      ) : st === '오류' ? (
        <ErrorState />
      ) : (
        <div className="col gap-7 md:gap-6 xl:gap-5">
          <TodoSection />
          <ListSection reReq={reReq} />
        </div>
      )}

      <PreviewStateSwitcher path={routes.events()} states={HOME_STATES} current={st} keep={pv.keep} />
    </>
  );
}

/* ---------- 할 일 ---------- */

function Tile({
  icon,
  iconTone,
  label,
  value,
  meta,
  link,
  className,
}: {
  icon: string;
  iconTone?: 'danger' | 'warning';
  label: string;
  value: string;
  meta: string;
  link?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`stat max-md:gap-1 max-md:px-3.5 max-md:py-3 xl:gap-1 xl:px-3.5 xl:py-3 ${className ?? ''}`}>
      <span className="stat-label row" style={{ gap: 6, alignItems: 'flex-start' }}>
        <i className={`ic ${icon} ic-16${iconTone ? ` tx-${iconTone}` : ''}`} aria-hidden="true" />
        {label}
      </span>
      <span className="stat-value xl:text-[24px] xl:leading-[30px]">{value}</span>
      <span className="stat-meta">{meta}</span>
      {link}
    </div>
  );
}

function MoreLink({ href, children, label, className }: { href: string; children: ReactNode; label?: string; className?: string }) {
  return (
    <Link className={`link-more max-md:mt-auto max-md:pt-1.5 xl:text-[13px] ${className ?? ''}`} href={href} aria-label={label}>
      {children}
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );
}

function TodoSection() {
  const lumen = 'evt-lumen-2026';
  return (
    <section className="col gap-3 xl:gap-2.5" aria-labelledby="h-todo">
      <h2 className="t-md fw-b" id="h-todo">
        할 일
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4 xl:grid-cols-6 xl:gap-3">
        <Tile className="hidden xl:flex" icon="ic-stamp" label="판매 승인 대기" value="1건" meta="팬미팅 · PEAKET 운영자 확인 중" />
        <Tile
          icon="ic-x-circle"
          iconTone="danger"
          label="반려된 판매 승인"
          value="1건"
          meta="가을 뮤지컬 · 통신판매업 신고번호 누락"
          link={
            <>
              <MoreLink className="max-md:hidden" href={routes.eventTab('evt-autumn-musical', 'edit')} label="가을 뮤지컬 고쳐서 다시 요청">
                고쳐서 다시 요청
              </MoreLink>
              <MoreLink className="md:hidden" href={`${routes.event('evt-autumn-musical')}?state=반려`} label="가을 뮤지컬 반려 사유 보기">
                반려 사유 보기
              </MoreLink>
            </>
          }
        />
        <Tile
          icon="ic-clock"
          iconTone="warning"
          label="정산 이의 기한"
          value="내일"
          meta="10/15(목)까지 · 지난 공연 정산서 1건"
          link={<MoreLink href={routes.eventTab('evt-small-musical', 'settlement')}>정산서 보기</MoreLink>}
        />
        <Tile
          icon="ic-flag"
          label="미처리 이상 표시"
          value="3건"
          meta="현장 운영 표에서 처리합니다"
          link={<MoreLink href={routes.eventTab(lumen, 'staff')}>현장 운영</MoreLink>}
        />
        <Tile
          icon="ic-users"
          label="수락 안 한 스태프 초대"
          value="5건"
          meta="LUMEN 10/25(일) 18:00 KST 회차"
          link={<MoreLink href={routes.eventTab(lumen, 'staff')}>현장 스태프</MoreLink>}
        />
        <Tile
          className="hidden xl:flex"
          icon="ic-link"
          iconTone="danger"
          label="웹훅 수신 실패"
          value="2건"
          meta="DLQ로 옮긴 이벤트 · 다시 보낼 수 있음"
          link={<MoreLink href={routes.settingsWebhooks()}>웹훅</MoreLink>}
        />
      </div>
    </section>
  );
}

/* ---------- 공연 목록 ---------- */

function reviewCell(p: Production, reReq: boolean): { badge: ReactNode; note?: ReactNode } {
  // '재승인 대기(판매 계속)' 상태는 가을 야외 페스티벌 행을 재승인 대기로 그린다(보드)
  if (reReq && p.id === 'evt-autumn-fest') {
    return {
      badge: <span className="badge badge-warning">재승인 대기</span>,
      note: <span className="t-xs muted">판매 계속 · 공개 중인 내용과 판매는 승인될 때까지 그대로입니다</span>,
    };
  }
  const badge = <span className={SALE_REVIEW_BADGE[p.review]}>{SALE_REVIEW_LABEL[p.review]}</span>;
  if (p.review === 'SUBMITTED') return { badge, note: <span className="t-xs muted">PEAKET 운영자가 확인하고 있습니다</span> };
  if (p.reviewNote) return { badge, note: <span className="t-xs">사유: {p.reviewNote}</span> };
  return { badge };
}

function SaleStatus({ p }: { p: Production }) {
  if (p.saleStatus === 'NONE') return <span className="muted">—</span>;
  return <span className={SALE_STATUS_BADGE[p.saleStatus]}>{SALE_STATUS_LABEL[p.saleStatus]}</span>;
}

function FirstOpen({ p }: { p: Production }) {
  if (p.firstOpenAt) return <span className="num nowrap">{p.firstOpenAt}</span>;
  // 승인된 공연인데 첫 오픈을 아직 목업에 정하지 않은 행은 보드처럼 자리 표시
  return <span className="nowrap muted">{p.review === 'APPROVED' ? '[오픈 일시]' : '—'}</span>;
}

function Rate({ p, align = 'end' }: { p: Production; align?: 'end' | 'row' }) {
  if (p.saleRate === null) return <span className="muted">—</span>;
  const bar = (
    <div className="progress" style={{ width: 72 }} aria-hidden="true">
      <span style={{ width: `${p.saleRate}%` }} />
    </div>
  );
  if (align === 'row')
    return (
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        {bar}
        <span className="num">{p.saleRate}%</span>
      </div>
    );
  return (
    <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
      <span className="num">{p.saleRate}%</span>
      {bar}
    </div>
  );
}

function NextActions({ p, mobile = false }: { p: Production; mobile?: boolean }) {
  if (p.review === 'SUBMITTED') return <span className="t-sm muted">승인을 기다리는 중</span>;
  if (p.review === 'SUSPENDED')
    return (
      <a className="link-more" href={SUPPORT_HREF} aria-label={`${p.name} 파트너 지원 문의`}>
        파트너 지원 문의
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
    );
  if (p.review === 'REJECTED' || p.review === 'CHANGE_REJECTED')
    return mobile ? null : (
      <Link className="btn btn-outline btn-sm" href={routes.eventTab(p.id, 'edit')} aria-label={`${p.name} 고쳐서 다시 요청`}>
        고쳐서 다시 요청
      </Link>
    );
  const links = [
    { href: routes.eventTab(p.id, 'live'), text: '판매 현황' },
    ...(p.saleStatus === 'SOLD_OUT' ? [] : [{ href: routes.eventTab(p.id, 'staff'), text: '현장' }]),
  ];
  return (
    <div className="row wrap" style={{ gap: mobile ? 16 : '4px 12px' }}>
      {links.map((l) => (
        <Link key={l.text} className="link-more" href={l.href} aria-label={`${p.name} ${l.text}`}>
          {l.text}
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      ))}
    </div>
  );
}

function SelectField({ id, label, options, selected, className }: { id: string; label: string; options: string[]; selected?: string; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="input-group input-group-sm max-md:h-12">
        <select id={id} defaultValue={selected ?? options[0]}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
      </div>
    </div>
  );
}

function SortButton({ children, sort }: { children: string; sort?: 'descending' }) {
  return (
    <button
      className="row"
      type="button"
      style={{ gap: 4, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: sort ? 'var(--text)' : undefined }}
    >
      {children}
      <i className={`ic ${sort ? 'ic-chevron-down' : 'ic-sort'} ic-14`} aria-hidden="true" />
    </button>
  );
}

function ListSection({ reReq }: { reReq: boolean }) {
  const count = productions.length;
  return (
    <section className="col gap-3 xl:gap-2.5" aria-labelledby="h-list">
      <div className="section-title">
        <div className="row" style={{ gap: 12 }}>
          <h2 id="h-list">공연 목록</h2>
          <span className="t-sm muted">
            {count}건<span className="max-md:hidden"> · 첫 오픈 늦은 순</span>
          </span>
        </div>
        <Link className="btn btn-primary max-md:hidden" href={routes.eventNew()}>
          <i className="ic ic-plus" aria-hidden="true" />새 공연 등록
        </Link>
        <button className="btn btn-ghost btn-sm md:hidden" type="button" aria-haspopup="listbox" aria-label="정렬 바꾸기, 지금은 첫 오픈 늦은 순">
          <i className="ic ic-sort" aria-hidden="true" />첫 오픈 늦은 순
        </button>
      </div>
      <BigScreenNotice title="새 공연 등록은 태블릿이나 데스크톱에서 합니다" path={routes.eventNew()} />

      <form
        className="toolbar max-md:grid max-md:grid-cols-2 max-md:gap-2.5"
        role="search"
        aria-label="공연 거르기"
        action={routes.events()}
        style={{ alignItems: 'flex-end', gap: 12 }}
      >
        <SelectField
          id="f-review"
          label="판매 승인"
          className="md:w-[150px]"
          options={['전체', '초안', '승인 대기', '재승인 대기', '승인', '반려', '변경 반려', '판매 중지']}
        />
        <SelectField id="f-sale" label="판매 상태" className="md:w-[150px]" options={['전체', '오픈 예정', '판매 중', '매진', '판매 종료', '오픈 예약 멈춤']} />
        <SelectField
          id="f-period"
          label="기간"
          className="max-md:col-span-2 md:w-[200px]"
          options={['전체', '다가오는·진행 중 공연', '지난 공연']}
          selected="다가오는·진행 중 공연"
        />
        <SelectField id="f-pg" label="결제사" className="hidden xl:flex xl:w-[160px]" options={['전체', '토스페이먼츠', '포트원']} />
        <div className="field grow max-md:col-span-2">
          <label className="label" htmlFor="f-q">
            공연명
          </label>
          <div className="input-group input-group-sm max-md:h-12">
            <i className="ic ic-search ic-16" aria-hidden="true" />
            <input id="f-q" type="search" name="q" placeholder="공연명으로 찾기" />
          </div>
        </div>
      </form>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="t-xs muted">적용한 조건</span>
        <button className="chip chip-sm" type="button" aria-label="조건 지우기: 기간 다가오는·진행 중 공연">
          기간: 다가오는·진행 중 공연
          <i className="ic ic-close" aria-hidden="true" />
        </button>
      </div>

      {/* 태블릿·데스크톱: 표(태블릿은 가로 스크롤 상자) */}
      <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="공연 목록 표" tabIndex={0}>
        <table className="table" style={{ minWidth: 900 }}>
          <caption className="sr-only">공연 목록 {count}건, 첫 오픈 늦은 순. 판매 승인 상태와 다음 할 일. 좁은 화면에서는 표를 가로로 밀어 볼 수 있습니다</caption>
          <thead>
            <tr>
              <th scope="col" aria-sort="none">
                <SortButton>공연</SortButton>
              </th>
              <th scope="col" className="r">
                회차 수
              </th>
              <th scope="col">판매 승인</th>
              <th scope="col" aria-sort="descending">
                <SortButton sort="descending">첫 오픈</SortButton>
              </th>
              <th scope="col">판매 상태</th>
              <th scope="col" className="r">
                판매율
              </th>
              <th scope="col" className="hidden xl:table-cell">
                결제사
              </th>
              <th scope="col" className="hidden xl:table-cell">
                정산
              </th>
              <th scope="col" className="hidden xl:table-cell">
                현장 스태프
              </th>
              <th scope="col">다음 할 일</th>
            </tr>
          </thead>
          <tbody>
            {productions.map((p) => {
              const rv = reviewCell(p, reReq);
              return (
                <tr key={p.id}>
                  <td>
                    <Link className="fw-b" href={routes.event(p.id)} style={{ color: 'inherit' }}>
                      {p.name}
                    </Link>
                  </td>
                  <td className="r">{p.roundCount}</td>
                  <td>
                    {rv.badge}
                    {rv.note ? <span style={{ display: 'block', marginTop: 4 }}>{rv.note}</span> : null}
                  </td>
                  <td>
                    <FirstOpen p={p} />
                  </td>
                  <td>
                    <SaleStatus p={p} />
                  </td>
                  <td className="r">
                    <Rate p={p} />
                  </td>
                  <td className={`hidden xl:table-cell nowrap${p.xl.provider === '승인 때 지정' || p.xl.provider === '—' ? ' muted' : ''}`}>
                    {p.xl.provider}
                  </td>
                  <td className="hidden xl:table-cell">
                    <span className={`nowrap${p.xl.settlement === '—' ? ' muted' : ''}`}>{p.xl.settlement}</span>
                    {p.xl.settlementNote ? (
                      <span className="t-xs muted" style={{ display: 'block' }}>
                        {p.xl.settlementNote}
                      </span>
                    ) : null}
                  </td>
                  <td className={`hidden xl:table-cell nowrap${p.xl.staff === '—' ? ' muted' : ''}`}>{p.xl.staff}</td>
                  <td>
                    <NextActions p={p} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 휴대폰: 카드 목록(핵심 칸만, d5 §3.9) */}
      <ul className="col md:hidden" style={{ gap: 12 }} aria-label={`공연 목록 ${count}건, 첫 오픈 늦은 순`}>
        {productions.map((p) => {
          const rv = reviewCell(p, reReq);
          const rejected = p.review === 'REJECTED' || p.review === 'CHANGE_REJECTED';
          return (
            <li key={p.id}>
              <article className="card col" style={{ padding: 16, gap: 12 }} aria-labelledby={`ev-${p.id}`}>
                <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <div className="col" style={{ gap: 2, minWidth: 0 }}>
                    <h3 className="t-md fw-b" id={`ev-${p.id}`}>
                      <Link href={routes.event(p.id)} style={{ color: 'inherit' }}>
                        {p.name}
                      </Link>
                    </h3>
                    <span className="t-xs muted">회차 {p.roundCount}개</span>
                  </div>
                  {rv.badge}
                </div>
                {rv.note ? <p className={p.reviewNote ? 't-sm' : 't-xs muted'}>{rv.note}</p> : null}
                <dl className="kv">
                  <dt>첫 오픈</dt>
                  <dd>
                    <FirstOpen p={p} />
                  </dd>
                  <dt>판매 상태</dt>
                  <dd>
                    <SaleStatus p={p} />
                  </dd>
                  <dt>판매율</dt>
                  <dd>
                    <Rate p={p} align="row" />
                  </dd>
                </dl>
                {rejected ? (
                  <div className="col" style={{ gap: 8, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                    <span className="t-xs muted">다음 할 일</span>
                    <BigScreenNotice
                      title="'고쳐서 다시 요청'은 태블릿이나 데스크톱에서 합니다"
                      copyLabel={`${p.name} 고쳐서 다시 요청 화면의 링크 복사`}
                      path={routes.eventTab(p.id, 'edit')}
                    />
                  </div>
                ) : (
                  <div className="row between" style={{ gap: 8, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                    <span className="t-xs muted">다음 할 일</span>
                    <NextActions p={p} mobile />
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ul>
      <p className="t-xs muted">
        판매율은 약 1분 늦은 잠정 집계입니다. 확정 숫자는 판매 요약 리포트에서 봅니다.
        <span className="hidden xl:inline"> 정산서는 회차가 끝난 다음 영업일에 만들고 2영업일 동안 이의를 받습니다.</span> 공연명을 누르면 공연 개요로
        갑니다.
      </p>
    </section>
  );
}

/* ---------- 빈·로딩·오류 ---------- */

function EmptyState() {
  return (
    <section className="card" aria-labelledby="h-empty">
      <div className="state px-4 pb-5 pt-12 md:px-6 md:py-[72px]">
        <span className="state-icon is-primary">
          <i className="ic ic-ticket" aria-hidden="true" />
        </span>
        <h2 className="t-lg" id="h-empty">
          등록한 공연이 없습니다
        </h2>
        <p className="t-sm muted" style={{ maxWidth: 440 }}>
          공연을 등록하고 판매 승인을 요청하면 이곳에서 승인 상태와 판매 상태를 봅니다.
        </p>
        <Link className="btn btn-primary btn-lg max-md:hidden" href={routes.eventNew()}>
          <i className="ic ic-plus" aria-hidden="true" />새 공연 등록
        </Link>
      </div>
      <div className="md:hidden" style={{ padding: '0 16px 16px' }}>
        <BigScreenNotice title="새 공연 등록은 태블릿이나 데스크톱에서 합니다" path={routes.eventNew()} />
      </div>
    </section>
  );
}

// d5 §6.2 '로딩·에러: 표 스켈레톤 / 재시도'(보드에 없는 상태라 키트 .skel·.state로 그렸다)
function LoadingState() {
  return (
    <section className="col" style={{ gap: 12 }} aria-busy="true" aria-labelledby="h-loading">
      <h2 className="sr-only" id="h-loading">
        공연 목록을 불러오는 중
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skel" style={{ height: 112 }} />
        ))}
      </div>
      <div className="table-wrap col" style={{ padding: 12, gap: 10 }} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className="skel" style={{ height: 36 }} />
        ))}
      </div>
      <p className="t-sm muted" role="status">
        공연 목록을 불러오고 있습니다
      </p>
    </section>
  );
}

function ErrorState() {
  return (
    <section className="card" aria-labelledby="h-error">
      <div className="state" style={{ padding: '56px 24px' }}>
        <span className="state-icon is-danger">
          <i className="ic ic-alert-circle" aria-hidden="true" />
        </span>
        <h2 className="t-lg" id="h-error">
          공연 목록을 불러오지 못했습니다
        </h2>
        <p className="t-sm muted" role="alert">
          잠시 뒤 다시 시도해 주세요. 계속 안 되면 파트너 지원으로 문의해 주세요.
        </p>
        <Link className="btn btn-outline" href={routes.events()}>
          <i className="ic ic-refresh" aria-hidden="true" />
          다시 시도
        </Link>
      </div>
    </section>
  );
}
