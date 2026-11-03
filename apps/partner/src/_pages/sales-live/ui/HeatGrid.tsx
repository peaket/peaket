// 구역별 잔여석 격자(CMP-034 HeatmapGrid, 키트 .heat). 보드 SCR-026 m·t·d·xl의 칸 폭·칸 이름을 중단점으로 바꾼다.
// 휴대폰 'R1' · 1~3 · 잔여 / 태블릿·데스크톱 'R1구역 · R석' · 1~3열 · 구역 잔여(…석) / xl 'R1 · R석' · 1~3열 · 잔여
import { cx } from '@/shared/lib/cx';
import { HEAT_SUMMARY, ROW_BANDS, fmt, heatRows, type HeatRow } from '../model/live';
import { ROW_HEAD } from './MinuteChart';

const GRID_COLS =
  'grid-cols-[28px_repeat(6,minmax(0,1fr))_30px] md:grid-cols-[116px_repeat(6,minmax(0,1fr))_64px] lg:grid-cols-[132px_repeat(6,minmax(0,1fr))_72px] xl:grid-cols-[96px_repeat(6,minmax(0,1fr))_52px]';

function ZoneLabel({ r }: { r: HeatRow }) {
  return (
    <>
      {r.zone}
      <span className="hidden md:inline xl:hidden">구역</span>
      <span className="max-md:hidden"> · {r.grade}</span>
    </>
  );
}

export function HeatGrid({ before }: { before: boolean }) {
  const rows = heatRows(before);
  return (
    <div className={cx('heat', GRID_COLS)} role="img" aria-label={before ? HEAT_SUMMARY.before : HEAT_SUMMARY.live}>
      <div className="t-xs muted" style={{ alignSelf: 'end' }}>
        <span className="md:hidden">구역</span>
      </div>
      {ROW_BANDS.map((b) => (
        <div key={b} className="t-xs muted" style={{ textAlign: 'center', alignSelf: 'end' }}>
          {b}
          <span className="max-md:hidden">열</span>
        </div>
      ))}
      <div className="t-xs muted" style={{ textAlign: 'right', alignSelf: 'end' }}>
        <span className="hidden md:inline xl:hidden">구역 </span>잔여
      </div>
      {rows.map((r) => (
        <HeatRowCells key={r.zone} r={r} />
      ))}
    </div>
  );
}

function HeatRowCells({ r }: { r: HeatRow }) {
  return (
    <>
      <div className="t-sm fw-b xl:text-[12px] xl:leading-4" style={{ alignSelf: 'center' }}>
        <ZoneLabel r={r} />
      </div>
      {r.cells.map((c, i) => (
        <span key={i} className={c.level ?? undefined} style={c.span > 1 ? { gridColumn: `span ${c.span}` } : undefined}>
          {c.rem === null ? '—' : fmt(c.rem)}
          {c.span > 1 ? ' · 합침' : ''}
        </span>
      ))}
      <div className="t-xs num md:text-[14px] md:leading-[19px] xl:text-[12px] xl:leading-4" style={{ alignSelf: 'center', textAlign: 'right' }}>
        {fmt(r.total)}
        <span className="hidden md:inline xl:hidden">석</span>
      </div>
    </>
  );
}

/** 남은 비율 범례와 칸 설명(보드: 데스크톱은 한 줄 양끝, 태블릿·xl은 두 줄, 휴대폰은 범례를 세 칸으로) */
export function HeatLegend() {
  const cell = 'px-1 py-0.5 text-center md:px-2.5 md:py-0';
  return (
    <div className="flex flex-col gap-1.5 md:gap-2 lg:max-xl:flex-row lg:max-xl:flex-wrap lg:max-xl:items-center lg:max-xl:justify-between lg:max-xl:gap-x-4">
      <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:gap-2.5">
        <span className="t-xs muted">남은 비율</span>
        <div className="heat grid-cols-3 md:grid-cols-[repeat(3,auto)]">
          <span className={cx('h1', cell)}>50% 이상</span>
          <span className={cx('h2', cell)}>10% 이상 50% 미만</span>
          <span className={cx('h3', cell)}>10% 미만(매진 포함)</span>
        </div>
      </div>
      <span className="t-xs muted">— 칸은 그 열 묶음에 좌석이 없음 · 판매 5건 [가정] 미만 칸은 옆 칸과 합쳐 보입니다</span>
    </div>
  );
}

/** '표로 보기': 구역 × 열 묶음 남은 좌석 수 */
export function HeatTable({ before }: { before: boolean }) {
  const rows = heatRows(before);
  return (
    <div className="table-wrap table-scroll" role="region" aria-label="구역별 잔여석 표" tabIndex={0}>
      <table className="table dense" style={{ minWidth: 600 }}>
        <caption className="sr-only">구역 6곳의 열 묶음(무대 쪽부터 3열씩)별 남은 좌석 수(잠정). 판매 5건 미만 칸은 합쳐 보입니다</caption>
        <thead>
          <tr>
            <th scope="col">구역</th>
            {ROW_BANDS.map((b) => (
              <th key={b} scope="col" className="r">
                {b}열
              </th>
            ))}
            <th scope="col" className="r">
              구역 잔여
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.zone}>
              <th scope="row" className="nowrap" style={ROW_HEAD}>
                {r.zone}구역 · {r.grade}
              </th>
              {r.cells.map((c, i) => (
                <td key={i} className="r" colSpan={c.span > 1 ? c.span : undefined}>
                  {c.rem === null ? (
                    <>
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">좌석 없음</span>
                    </>
                  ) : (
                    `${fmt(c.rem)}${c.span > 1 ? ' (합침)' : ''}`
                  )}
                </td>
              ))}
              <td className="r fw-b">{fmt(r.total)}석</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
