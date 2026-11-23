// 판매 중 탭 아래 '진단 힌트'(F-03-3 OPS-380, 위젯 키 ops-diagnostics.summary, d5 §7.2 '진단 힌트 · 운영 명령 없음(엔지니어 호출만)', ADR-0069).
// 운영 명령이 없는 숫자라 판단 위젯과 나누고 '판단:' 줄을 두지 않는다. 원천이 없으면 '받지 못함'이다.
// 원천(OPS-050·OPS-090) 전이라 서버가 늘 원천 실패 값을 내므로(ADR-0371 결정 8) 칸에 data-source="pending"과 '원천 연결 전' 배지를 단다(docs/frontend.md §5.7).
import type { TimeRange } from '@/shared/lib/links';
import { PendingBadge } from '../source-marks';
import { DetailAnchor, fmt, isUnavailable, NotReceived } from './frame';

export interface DiagnosticsValue {
  widgetKey: 'ops-diagnostics.summary';
  source: string;
  at: string;
  eventId: string | null;
  rumInpP75Ms: number | null;
  rumLcpP75Ms: number | null;
  slowQueries: { queryId?: string; db?: string; calls?: number; meanMs?: number; maxMs?: number }[];
  network: 'ok' | 'warn' | 'unknown';
}

const ms = (v: number | null) => (v === null ? <NotReceived /> : <span className="num">{`${fmt(v)}ms`}</span>);

export function DiagnosticsRow({ value, range, id = 'w-live-diag', loading }: { value: DiagnosticsValue | { error: 'source-unavailable'; eventId: string | null } | undefined; range: TimeRange; id?: string; loading?: boolean }) {
  const v = value && !isUnavailable(value) && 'network' in value ? value : null;
  return (
    <section className="widget" role="region" aria-labelledby={id} style={{ gridColumn: '1 / -1' }} data-source="pending">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id={id}>
          진단 힌트 · 운영 명령 없음
        </h2>
        <PendingBadge />
        <span className="t-xs muted">엔지니어 호출만</span>
        <div className="actions">
          <DetailAnchor title="진단 힌트" panel="diagnostics" eventId={value?.eventId ?? null} range={range} />
        </div>
      </div>
      <div className="widget-body">
        {loading ? (
          <p className="t-xs muted" role="status">불러오는 중입니다…</p>
        ) : v ? (
          <ul className="row wrap t-xs" style={{ gap: '6px 24px' }}>
            <li className="row" style={{ gap: 8 }}>
              <span>RUM INP p75</span>
              {ms(v.rumInpP75Ms)}
            </li>
            <li className="row" style={{ gap: 8 }}>
              <span>RUM LCP p75</span>
              {ms(v.rumLcpP75Ms)}
            </li>
            <li className="row" style={{ gap: 8 }}>
              <span>느린 쿼리 상위 5</span>
              <span className="num">{`${fmt(v.slowQueries.length)}건`}</span>
            </li>
            <li className="row" style={{ gap: 8 }}>
              <span>네트워크</span>
              {v.network === 'unknown' ? <NotReceived /> : <span className={v.network === 'ok' ? 'slo slo-ok' : 'slo slo-burning'}>{v.network === 'ok' ? '정상' : '주의'}</span>}
            </li>
          </ul>
        ) : (
          <p className="t-xs muted">
            <NotReceived /> RUM·느린 쿼리·네트워크 원천을 받지 못했습니다.
          </p>
        )}
      </div>
    </section>
  );
}
