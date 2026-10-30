// 아래 요약 줄(보드 SCR-022-d 한 줄 · -t 2열): 총 좌석 · 등급별 · 휠체어석 기준 검사 · 예상 매출, W1~W3·겹침·도형 밖 경고(d5 §6.5 문구 그대로).
import { Fragment, type ReactNode } from 'react';
import type { SummaryView } from '../model/view';
import { CriteriaToggle } from './EditorChrome';

interface Item {
  label: string;
  value: ReactNode;
  valueCls?: string;
  /** 값 옆 작은 글·배지 */
  extra?: ReactNode;
  meta?: string;
}

const ok = (
  <span className="badge badge-success">
    <i className="ic ic-check" aria-hidden="true" />
    수량 기준 충족
  </span>
);
const check = (text = '확인 필요') => (
  <span className="badge badge-warning">
    <i className="ic ic-alert" aria-hidden="true" />
    {text}
  </span>
);
const hint = (t: string) => <span className="t-xs muted">{t}</span>;

export const W1_TEXT =
  '휠체어석이 기준보다 8석 적습니다. 공연장 관람석 기준은 전체 좌석의 1% 이상(2,000석 이상이면 20석 이상)입니다. 공연장 배치도와 다르면 고치고, 같다면 판매 승인 요청 때 이유를 골라 주세요.';
export const W3_TEXT = '휠체어석이 모두 판매 제외라 PEAKET에서 예매할 수 없습니다. 휠체어석 예매 방법을 공연 설명에 적어 주세요.';

function itemsOf(view: SummaryView, zoneCount: number): { items: Item[]; foot?: string; banner?: string } {
  const total: Item = { label: '총 좌석', value: '2,400석', valueCls: 't-lg num' };
  const grades: Item = { label: '등급별', value: 'R 600 · S 900 · A 900' };
  const wcOk: Item = { label: '휠체어석(A석에 포함)', value: '20석', extra: <>{hint('기준 20석 이상')}{ok}</> };
  const revenue: Item = { label: '예상 매출 · 회차당, 전석 판매 기준', value: '₩310,200,000' };
  const place = (text: string, meta: string): Item => ({
    label: '좌석 위치',
    value: null,
    extra: (
      <>
        {check()}
        <span className="t-sm fw-b">{text}</span>
      </>
    ),
    meta,
  });
  switch (view) {
    case 'pass':
      return { items: [total, grades, wcOk, revenue], foot: `구역 ${zoneCount} · 입장 게이트 구역 동문·서문` };
    case 'fill':
      return {
        items: [{ ...total, value: '2,370석' }, { ...grades, value: 'R 600 · S 900 · A 870' }, wcOk, { ...revenue, value: '₩306,900,000' }],
        foot: '채우기 전 · 구역 6 · 입장 게이트 구역 동문·서문',
      };
    case 'over':
      return { items: [total, grades, { ...wcOk, extra: ok }, place('좌석 3석이 겹칩니다', 'R1구역 12열 7번·8번·9번')] };
    case 'out':
      return { items: [total, grades, { ...wcOk, extra: ok }, place('구역 도형 밖에 좌석 3석이 있습니다', 'S2구역 1열 1번·2번·3번')] };
    case 'warn':
      return { items: [total, grades, { ...wcOk, extra: check('위치 확인 2석'), meta: 'A1구역 18열 9번·10번' }, revenue] };
    case 'empty':
      return {
        items: [
          { ...total, value: '0석' },
          { ...grades, value: '없음', valueCls: 't-md fw-b muted' },
          { label: '휠체어석', value: '0석', extra: <span className="badge">검사 전</span> },
          { label: '예상 매출', value: '계산 전', valueCls: 't-md fw-b muted' },
        ],
      };
    case 'w1':
      return { items: [total, grades, { ...wcOk, value: '12석', extra: <>{hint('기준 20석 이상')}{check()}</> }, revenue], banner: W1_TEXT };
    case 'w3':
      return {
        items: [
          total,
          grades,
          { ...wcOk, extra: <>{hint('판매 대상 0석 · 기준 20석 이상')}{check()}</> },
          { label: '예상 매출 · 회차당, 판매 대상 좌석 기준', value: '₩308,000,000' },
        ],
        banner: W3_TEXT,
      };
  }
}

export function SummaryCard({ view, zoneCount, criteriaOpen }: { view: SummaryView; zoneCount: number; criteriaOpen: boolean }) {
  const { items, foot, banner } = itemsOf(view, zoneCount);
  return (
    <section className="card max-lg:px-5 max-lg:py-4" aria-label="좌석 요약" style={{ padding: '12px 20px' }}>
      <div className="col" style={{ gap: 12 }}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 lg:flex lg:flex-wrap lg:items-stretch lg:gap-x-6 lg:gap-y-2.5">
          {items.map((it, i) => (
            <Fragment key={it.label}>
              {i > 0 ? <span className="vdivider hidden lg:block" aria-hidden="true" /> : null}
              <div className="col" style={{ gap: 2 }}>
                <span className="stat-label">{it.label}</span>
                {it.value !== null && !it.extra ? <span className={it.valueCls ?? 't-md fw-b num'}>{it.value}</span> : null}
                {it.extra ? (
                  <span className="row wrap" style={{ gap: '4px 8px' }}>
                    {it.value !== null ? <span className={it.valueCls ?? 't-md fw-b num'}>{it.value}</span> : null}
                    {it.extra}
                  </span>
                ) : null}
                {it.meta ? <span className="t-xs muted">{it.meta}</span> : null}
              </div>
            </Fragment>
          ))}
          {foot ? <span className="t-xs muted col-span-2 lg:ml-auto lg:self-center">{foot}</span> : null}
        </div>
        {banner ? (
          <div className="banner banner-warning" role="status">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body">{banner}</div>
          </div>
        ) : null}
      </div>
      <CriteriaToggle defaultOpen={criteriaOpen} idPrefix="d" />
    </section>
  );
}
