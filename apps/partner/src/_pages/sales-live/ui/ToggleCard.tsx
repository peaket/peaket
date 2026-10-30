'use client';
// 그래프·격자 카드와 '표로 보기' 전환(d5 §6.9 '표 보기 전환', d3 SCR-026 '차트 데이터는 표 형태의 대체 보기도 함께 둔다').
// 보드 버튼은 이름이 늘 '표로 보기'이고 aria-pressed로 켜고 끈다. 켜진 모양은 키트 btn-secondary로 보인다.
import { useState, type ReactNode } from 'react';

export interface ToggleCardProps {
  titleId: string;
  title: ReactNode;
  sub: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  children?: ReactNode;
}

export function ToggleCard({ titleId, title, sub, chart, table, children }: ToggleCardProps) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="card col gap-3 p-4 md:p-6" aria-labelledby={titleId}>
      <div className="row between max-md:items-start lg:max-xl:flex-wrap" style={{ gap: 12 }}>
        <div className="col" style={{ gap: 2 }}>
          <h3 className="t-md fw-b" id={titleId}>
            {title}
          </h3>
          <span className="t-xs muted">{sub}</span>
        </div>
        <button
          className={asTable ? 'btn btn-secondary btn-sm' : 'btn btn-outline btn-sm'}
          type="button"
          aria-pressed={asTable}
          style={{ flex: 'none' }}
          onClick={() => setAsTable((v) => !v)}
        >
          <i className="ic ic-list" aria-hidden="true" />
          표로 보기
        </button>
      </div>
      {asTable ? table : chart}
      {children}
    </section>
  );
}
