// 판매 중 탭 '구역별 잔여석' 칸의 실제 값(F-04-1 KPI 패널, 관제 실시간 표 rt-sales.summary, docs/streaming.md §4.1·§4.5).
// 호스트가 그리는 칸이다(원격 아님). 값은 위젯 조회(처음)와 위젯 흐름(1초)으로 받고, 원천을 못 읽으면 '받지 못함' 카드다(CMP-035).
// 실시간 숫자는 잠정값이라 머리에 '잠정'을 달고, 신선도 5초 이상은 경고, Degraded면 대체 표시 문구, 거래 사건이 끊기면 '거래 사건 끊김'을 띄운다
// (control-tower §2 '판매 진행 중', C-T36·C-T37). 퍼블리싱(?state=) 화면은 이 칸 대신 보드의 고정 자료를 그린다.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { WidgetKey } from '@peaket/console-contract';
import { servicesFor } from '@/shared/api/live';
import { useLiveHost } from '@/shared/model/live-host';
import { RT_SALES_KEY, isUnavailable, rtSalesViewOf, type RtSalesValue } from '../model/rt-sales-value';
import { FailCard, Skeleton } from './WidgetSlot';

const TITLE = '구역별 잔여석';
const KEY = RT_SALES_KEY as WidgetKey;

export function RtSalesCell({ id, style }: { id: string; style?: CSSProperties }) {
  const eventId = useLiveHost((s) => s.scope.eventId);
  const services = useMemo(() => servicesFor('rt-sales'), []);
  const [value, setValue] = useState<RtSalesValue | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    setValue(null);
    services.data
      .query<RtSalesValue>(KEY, { eventId })
      .then((v) => alive && setValue(isUnavailable(v) ? 'failed' : v))
      .catch(() => alive && setValue('failed'));
    const off = services.data.subscribe<RtSalesValue>(KEY, {}, (v) => {
      if (alive) setValue(isUnavailable(v) ? 'failed' : v);
    });
    return () => {
      alive = false;
      off();
    };
  }, [services, eventId]);
  if (value === null) return <Skeleton title={TITLE} style={style} />;
  if (value === 'failed') return <FailCard title={TITLE} style={style} />;
  const v = rtSalesViewOf(value);
  return (
    <section className="widget" role="region" aria-labelledby={id} style={style} data-source="rt" data-widget={RT_SALES_KEY}>
      <div className="widget-head">
        <h2 className="t-sm fw-b" id={id}>
          {TITLE}
        </h2>
        <span className="badge badge-outline">잠정</span>
        <span className={v.freshness.late ? 'badge badge-warning' : 'badge badge-outline'} title="관제 실시간 표 신선도(5초 미만이 정상)">
          {v.freshness.text}
        </span>
        {v.tradeGap ? <span className="badge badge-warning">거래 사건 끊김</span> : null}
        {v.degraded ? <span className="badge badge-warning">축소 표시</span> : null}
      </div>
      <div className="widget-body grow">
        {v.degraded ? <p className="t-xs muted">3분 넘게 늦어 구역별 잔여석을 Prometheus 대체 표시(퍼널 카운터의 전체 숫자)로 바꿨습니다</p> : null}
        <div className="row wrap" style={{ gap: '16px' }}>
          {v.tiles.map((t) => (
            <div key={t.label} className="stat">
              <span className="stat-label">{t.label}</span>
              <span className="stat-value">{t.value}</span>
            </div>
          ))}
        </div>
        {v.remainingUnknown ? <p className="t-xs muted">회차 기준 자료(판매 대상 좌석 수)를 아직 받지 못해 잔여석을 셀 수 없습니다.</p> : null}
        <div className="row between wrap" style={{ gap: '8px' }}>
          <span className="t-xs muted">숫자는 남은 좌석 수입니다. 색이 진할수록 남은 비율이 낮습니다.</span>
          <div className="heat" aria-hidden="true" style={{ gridTemplateColumns: 'repeat(3,auto)' }}>
            <span className="h1">50% 이상</span>
            <span className="h2">10% 이상 50% 미만</span>
            <span className="h3">10% 미만(매진 포함)</span>
          </div>
        </div>
        <div className="heat" role="img" aria-label={v.summary} style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(6, v.sections.length))},minmax(0,1fr))` }}>
          {v.sections.map((s) => (
            <span key={s.sectionId} className={s.heat ?? undefined}>
              {s.sectionId} {s.remaining}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
