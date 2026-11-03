// SCR-055 주문 목록(캔버스 보드 SCR-055 목록·굿즈 탭). 휴대폰은 카드 한 줄, 태블릿(md)은 카드 두 줄, 데스크톱(lg)은 표(키트 .table,
// d3 CMP-031 comfortable 모양)다. 상태 배지는 늘 글자로 보인다(ADR-0062). 상세 경로도 데스크톱 왼쪽 표로 이 부품을 쓴다.
import Link from 'next/link';
import { Fragment, type CSSProperties } from 'react';
import { EmptyState } from '@peaket/ds/EmptyState';
import type { HistoryBadge } from '@/entities/account';
import { formatWon } from '@/entities/production';
import { searchHref } from '@/shared/config/genres';
import { cx } from '@/shared/lib/cx';
import { badgeClass, inTab, tabCounts, type OrderRow, type OrderTab, type RowPart } from '../model/rows';
import { OrderTabs } from './OrderTabs';

const TOP: CSSProperties = { verticalAlign: 'top' };
const MORE = <i className="ic ic-chevron-right" aria-hidden="true" />;

function Parts({ parts }: { parts: RowPart[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? ' · ' : null}
          {p.text}
          {p.text && p.amount !== undefined ? ' ' : null}
          {p.amount !== undefined ? <span className="num">{formatWon(p.amount)}</span> : null}
        </Fragment>
      ))}
    </>
  );
}

function Badges({ badges }: { badges: readonly HistoryBadge[] }) {
  if (badges.length === 1) return <span className={badgeClass(badges[0]!.tone)}>{badges[0]!.text}</span>;
  return (
    <span className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
      {badges.map((b) => (
        <span key={b.text} className={badgeClass(b.tone)}>
          {b.text}
        </span>
      ))}
    </span>
  );
}

/** 휴대폰·태블릿 카드 목록 */
export function OrderCards({ rows }: { rows: OrderRow[] }) {
  return (
    <ul className="col gap-3 md:grid md:grid-cols-2 md:gap-4 lg:hidden">
      {rows.map((r) => (
        <li key={r.id}>
          <article className="card col h-full" style={{ padding: '14px 16px', gap: 6 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <p className="t-xs muted grow">
                {r.kindLabel} · 주문번호 <span className="mono">{r.number}</span>
              </p>
              <Badges badges={r.badges} />
            </div>
            <h2 className="t-md fw-b">
              <Link href={r.href} style={{ color: 'inherit' }}>
                {r.title}
              </Link>
            </h2>
            <p className="t-sm muted">
              <Parts parts={r.cardParts} />
            </p>
            {r.note ? <p className="t-sm">{r.note}</p> : null}
            {r.link ? (
              <Link className="link-more" href={r.link.href} style={{ alignSelf: 'flex-start' }}>
                {r.link.label}
                {MORE}
              </Link>
            ) : null}
            {r.alert ? (
              <div className="row wrap" style={{ gap: '4px 12px' }}>
                <span className="t-sm fw-b tx-warning">
                  <i className="ic ic-alert ic-16" aria-hidden="true" /> {r.alert.text}
                </span>
                <Link className="link-more" href={r.alert.link.href}>
                  {r.alert.link.label}
                  {MORE}
                </Link>
              </div>
            ) : null}
          </article>
        </li>
      ))}
    </ul>
  );
}

const CAPTION: Record<OrderTab, string> = {
  all: '예매·주문 내역, 주문일 최신순. 행을 고르면 오른쪽에 예매 확인서가 열립니다',
  ticket: '예매 내역, 주문일 최신순. 행을 고르면 오른쪽에 예매 확인서가 열립니다',
  goods: '굿즈·부가 상품 주문 내역, 주문일 최신순. 행을 고르면 오른쪽에 주문 확인서가 열립니다',
};
const ITEM_HEAD: Record<OrderTab, string> = { all: '공연·상품', ticket: '공연', goods: '상품' };

/** 데스크톱 표. selectedId 줄은 오른쪽 패널에 열린 주문(.is-selected, 링크 aria-current) */
export function OrderTable({ rows, tab, selectedId, className }: { rows: OrderRow[]; tab: OrderTab; selectedId?: string; className?: string }) {
  return (
    <div className={cx('table-wrap', className)}>
      <table className="table">
        <caption className="sr-only">{CAPTION[tab]}</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort="descending" style={{ width: 112 }}>
              <span className="row" style={{ gap: 4 }}>
                주문일
                <i className="ic ic-sort ic-14" aria-hidden="true" />
              </span>
            </th>
            <th scope="col">{ITEM_HEAD[tab]}</th>
            <th scope="col" className="r" style={{ width: 96 }}>
              금액
            </th>
            <th scope="col" style={{ width: tab === 'goods' ? 168 : 136 }}>
              상태
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const selected = r.id === selectedId;
            const simple = r.badges.length === 1 && !r.link && !r.alert;
            return (
              <tr key={r.id} className={selected ? 'is-selected' : undefined}>
                <td style={TOP}>
                  <p className="t-sm nowrap">{r.orderedText}</p>
                  <p className="mono t-xs muted">{r.number}</p>
                </td>
                <td style={TOP}>
                  <Link className="fw-b" href={r.href} style={{ color: 'inherit' }} aria-current={selected ? 'true' : undefined}>
                    {r.title}
                  </Link>
                  <p className="t-xs muted">
                    <Parts parts={r.tableParts} />
                  </p>
                  {r.note ? (
                    <p className="t-xs" style={{ marginTop: 4 }}>
                      {r.note}
                    </p>
                  ) : null}
                </td>
                <td className="r" style={TOP}>
                  {formatWon(r.amount)}
                </td>
                <td style={TOP}>
                  {simple ? (
                    <span className={badgeClass(r.badges[0]!.tone)}>{r.badges[0]!.text}</span>
                  ) : (
                    <div className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
                      {r.badges.map((b) => (
                        <span key={b.text} className={badgeClass(b.tone)}>
                          {b.text}
                        </span>
                      ))}
                      {r.alert ? <span className="t-xs fw-b tx-warning">{r.alert.text}</span> : null}
                      {r.alert ? (
                        <Link className="link-more" href={r.alert.link.href}>
                          {r.alert.link.label}
                          {MORE}
                        </Link>
                      ) : null}
                      {r.link ? (
                        <Link className="link-more" href={r.link.href}>
                          {r.link.label}
                          {MORE}
                        </Link>
                      ) : null}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 줄 스켈레톤(d5 §5.29 로딩) */
function OrderListSkeleton({ tableOnly }: { tableOnly: boolean }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">주문 내역을 불러오는 중</span>
      {tableOnly ? null : (
        <ul className="col gap-3 md:grid md:grid-cols-2 md:gap-4 lg:hidden" aria-hidden="true">
          {[0, 1, 2, 3].map((k) => (
            <li key={k} className="card col" style={{ padding: '14px 16px', gap: 8 }}>
              <span className="skel" style={{ height: 14, width: '55%' }} />
              <span className="skel" style={{ height: 18, width: '80%' }} />
              <span className="skel" style={{ height: 14, width: '65%' }} />
            </li>
          ))}
        </ul>
      )}
      <div className={cx('table-wrap', !tableOnly && 'hidden lg:block')} aria-hidden="true">
        {[0, 1, 2, 3, 4].map((k) => (
          <div key={k} className="row" style={{ gap: 16, padding: 12, borderBottom: '1px solid var(--border)' }}>
            <span className="skel" style={{ height: 32, width: 88, flex: 'none' }} />
            <span className="col grow" style={{ gap: 6 }}>
              <span className="skel" style={{ height: 16, width: '70%' }} />
              <span className="skel" style={{ height: 12, width: '50%' }} />
            </span>
            <span className="skel" style={{ height: 22, width: 96, flex: 'none' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface OrderHistoryTabsProps {
  rows: OrderRow[];
  defaultTab: OrderTab;
  /** cards: 카드(휴대폰·태블릿) + 표(데스크톱) · table: 표만(상세 경로의 데스크톱 왼쪽) */
  view: 'cards' | 'table';
  selectedId?: string;
  loading?: boolean;
  empty?: boolean;
}

/** 탭 + 탭마다 목록. 패널 셋을 서버에서 그려 클라이언트 탭에 넘긴다 */
export function OrderHistoryTabs({ rows, defaultTab, view, selectedId, loading = false, empty = false }: OrderHistoryTabsProps) {
  const panel = (tab: OrderTab) => {
    if (loading) return <OrderListSkeleton tableOnly={view === 'table'} />;
    if (empty)
      return (
        <EmptyState
          icon="receipt"
          title="주문 내역이 없습니다"
          style={{ padding: '56px 16px' }}
          actions={
            <Link className="btn btn-secondary" href={searchHref.all()}>
              공연 둘러보기
            </Link>
          }
        />
      );
    const list = rows.filter((r) => inTab(tab, r));
    return (
      <>
        {view === 'cards' ? <OrderCards rows={list} /> : null}
        <OrderTable rows={list} tab={tab} selectedId={selectedId} className={view === 'cards' ? 'hidden lg:block' : undefined} />
      </>
    );
  };
  return (
    <OrderTabs
      defaultTab={defaultTab}
      counts={loading || empty ? undefined : tabCounts(rows)}
      panels={{ all: panel('all'), ticket: panel('ticket'), goods: panel('goods') }}
    />
  );
}
