'use client';
// 그래프와 '표로 보기'(d5 §3.9 '차트는 폭에 맞추고 표로 보기를 남긴다', CMP-033). 그래프는 보드의 SVG를 그대로 쓴다.
import { useState, type ReactNode } from 'react';

export interface ChartOrTableProps {
  titleId: string;
  title: ReactNode;
  sub: ReactNode;
  chart: ReactNode;
  table: ReactNode;
}

export function ChartOrTable({ titleId, title, sub, chart, table }: ChartOrTableProps) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card col p-4 md:p-6" style={{ gap: 12 }} aria-labelledby={titleId}>
      <div className="row between" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b" id={titleId}>
            {title}
          </h3>
          <span className="t-xs muted">{sub}</span>
        </div>
        <button className="btn btn-outline btn-sm" type="button" aria-pressed={asTable} style={{ flex: 'none' }} onClick={() => setAsTable((v) => !v)}>
          <i className={asTable ? 'ic ic-chart' : 'ic ic-list'} aria-hidden="true" />
          {asTable ? '그래프로 보기' : '표로 보기'}
        </button>
      </div>
      {asTable ? table : chart}
    </section>
  );
}
