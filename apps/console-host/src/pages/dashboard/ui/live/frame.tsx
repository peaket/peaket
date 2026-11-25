// 실제 값 화면 위젯의 공통 틀(F-03-3 OPS-380): 머리의 '자세히 보기 ↗'(같은 회차·같은 시간대의 Grafana·Sentry 새 탭, ADR-0067)와
// 아래 '판단:' 한 줄(d5 §7.2 '위젯의 연결 판단', ADR-0069). 화면 글자는 여기서 만들고 서버 값은 숫자·상태만 받는다.
import type { CSSProperties, ReactNode } from 'react';
import { detailHref, NEW_TAB, type TimeRange } from '@/shared/lib/links';
import { judgementOf } from '../../model/judgement';

/** 원천을 읽지 못한 위젯 값(openapi OpsWidgetUnavailable) */
export interface WidgetUnavailableValue {
  widgetKey: string;
  source: string;
  at: string;
  eventId: string | null;
  error: 'source-unavailable';
}

export const isUnavailable = (v: unknown): v is WidgetUnavailableValue =>
  typeof v === 'object' && v !== null && (v as { error?: unknown }).error === 'source-unavailable';

/** 수를 천 단위로 쓴다(ko-KR) */
export const fmt = (n: number, digits = 0): string => n.toLocaleString('ko-KR', { maximumFractionDigits: digits });

/** KST 시각 글(HH:MM:SS KST) */
export function kst(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return `${new Date(ms + 9 * 3_600_000).toISOString().slice(11, 19)} KST`;
}

export function DetailAnchor({ title, kind = 'grafana', panel, eventId, range }: { title: string; kind?: 'grafana' | 'sentry'; panel: string; eventId: string | null | undefined; range: TimeRange }) {
  return (
    <a className="link-more" href={detailHref({ kind, panel, eventId, fromMs: range.fromMs, toMs: range.toMs })} {...NEW_TAB} aria-label={`${title} 자세히 보기, ${kind === 'sentry' ? 'Sentry' : 'Grafana'} 새 탭`}>
      자세히 보기
      <i className="ic ic-external" aria-hidden="true" />
    </a>
  );
}

export function JudgementLine({ widgetKey }: { widgetKey: string }) {
  const text = judgementOf(widgetKey);
  if (!text) return null;
  return (
    <p className="t-xs" style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <span className="fw-b">판단:</span> {text}
    </p>
  );
}

export interface LiveFrameProps {
  id: string;
  title: string;
  widgetKey: string;
  panel: string;
  eventId: string | null | undefined;
  range: TimeRange;
  kind?: 'grafana' | 'sentry';
  /** 머리 오른쪽의 상태 글(자세히 보기 앞) */
  status?: ReactNode;
  style?: CSSProperties;
  /** 원천 연결 전 카드면 'pending' */
  source?: 'pending';
  /** 위젯 자리 상태(F-03-6 FE-T29 첫 그림 표시): 값이 아직 없으면 loading, 값·빈 상태면 value, 대체 카드면 fallback */
  state?: 'loading' | 'value' | 'fallback';
  children: ReactNode;
}

export function LiveFrame({ id, title, widgetKey, panel, eventId, range, kind, status, style, source, state = 'value', children }: LiveFrameProps) {
  return (
    <section className="widget" role="region" aria-labelledby={id} style={style} data-source={source} data-slot-state={state}>
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id={id}>
          {title}
        </h2>
        <div className="actions" style={{ gap: 12 }}>
          {status}
          <DetailAnchor title={title} kind={kind} panel={panel} eventId={eventId} range={range} />
        </div>
      </div>
      <div className="widget-body grow" style={{ gap: 8 }}>
        {children}
        <JudgementLine widgetKey={widgetKey} />
      </div>
    </section>
  );
}

/** 값을 받지 못한 칸 */
export const NotReceived = () => <span className="slo slo-stale">받지 못함</span>;

/** 원천 기능이 붙기 전의 위젯 자리(고정 숫자를 실제 값으로 읽지 않게, 계획 6-9). 제목 id는 퍼블리싱 위젯과 같다 */
export function PendingCard({ id, title, origin, eventId, range, kind, style }: { id: string; title: string; origin: string; eventId: string | null | undefined; range: TimeRange; kind?: 'grafana' | 'sentry'; style?: CSSProperties }) {
  return (
    <section className="widget" role="region" aria-labelledby={id} style={style} data-source="pending" data-slot-state="fallback">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id={id}>
          {title}
        </h2>
        <span className="badge badge-outline">원천 연결 전</span>
        <div className="actions">
          <DetailAnchor title={title} kind={kind} panel={id} eventId={eventId} range={range} />
        </div>
      </div>
      <div className="widget-body grow">
        <p className="t-xs muted">원천 연결 전 · {origin}. 이 자리의 숫자는 원천 기능이 붙으면 실제 값으로 그립니다.</p>
      </div>
    </section>
  );
}
