// 위젯 공통 틀(키트 20절 .widget·.widget-head·.widget-body, d5 §7.2). 구매 팀 원격 안에만 둔다.
// 원격 위젯은 react와 @peaket/ds만 가져온다(docs/frontend.md §4.5). 데이터·상태는 호스트가 props로 넘긴다.
import type { CSSProperties, ReactNode } from 'react';

/** 호스트가 위젯 자리마다 넘기는 공통 속성(WidgetProps의 퍼블리싱 판, frontend §4.5) */
export interface WidgetBaseProps {
  /** 참이면 머리 한 줄(제목·상태 점·핵심 숫자)만 그린다(ADR-0091) */
  collapsed?: boolean;
  /** 신선도 'n초 전'. stale(5초 넘음)이면 warning으로 그린다. 없으면 그리지 않는다 */
  freshness?: { text: string; stale: boolean } | null;
  /** '자세히 보기 ↗'(같은 회차·시간대 Grafana 새 탭, ADR-0067) */
  detailHref: string;
  /** 격자 자리(예: { gridColumn: 'span 2' }) */
  style?: CSSProperties;
}

export function Freshness({ value }: { value?: WidgetBaseProps['freshness'] }) {
  if (!value) return null;
  return <span className={value.stale ? 'slo slo-burning' : 'slo slo-ok'}>{value.text}</span>;
}

export function DetailLink({ href, title }: { href: string; title: string }) {
  return (
    <a className="link-more" href={href} target="_blank" rel="noreferrer" aria-label={`${title} 자세히 보기, Grafana 새 탭`}>
      자세히 보기
      <i className="ic ic-external" aria-hidden="true" />
    </a>
  );
}

export function TableToggle() {
  return (
    <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
      <i className="ic ic-list" aria-hidden="true" />
      표로 보기
    </button>
  );
}

/** 위젯 아래 '판단:' 한 줄(ADR-0067·0069) */
export function Judgement({ children }: { children: ReactNode }) {
  return (
    <p className="t-xs" style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <span className="fw-b">판단:</span> {children}
    </p>
  );
}

export interface WidgetFrameProps {
  id: string;
  title: string;
  base: WidgetBaseProps;
  /** 제목 뒤 배지(잠정·대체 표시 등) */
  badges?: ReactNode;
  /** 머리 오른쪽(자세히 보기 앞에 붙는 것) */
  actions?: ReactNode;
  /** 머리 줄바꿈(보드의 widget-head wrap) */
  wrapHead?: boolean;
  bodyStyle?: CSSProperties;
  /** 접힌 줄의 상태 점·핵심 숫자 */
  foldMeta: ReactNode;
  children: ReactNode;
}

export function WidgetFrame({ id, title, base, badges, actions, wrapHead, bodyStyle, foldMeta, children }: WidgetFrameProps) {
  if (base.collapsed) {
    return (
      <details className="widget" style={{ alignSelf: 'start', ...base.style }}>
        <summary className="widget-head">
          <span>{title}</span>
          <span className="fold-meta">
            {foldMeta}
            <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
          </span>
        </summary>
      </details>
    );
  }
  return (
    <section className="widget" role="region" aria-labelledby={id} style={base.style}>
      <div className={wrapHead ? 'widget-head wrap' : 'widget-head'}>
        <h2 className="t-sm fw-b" id={id}>
          {title}
        </h2>
        <Freshness value={base.freshness} />
        {badges}
        <div className="actions" style={actions ? { gap: 12 } : undefined}>
          {actions}
          <DetailLink href={base.detailHref} title={title} />
        </div>
      </div>
      <div className="widget-body grow" style={bodyStyle}>
        {children}
      </div>
    </section>
  );
}

/** 막대(키트 .progress). 값은 0~100 */
export function Progress({ label, pct, tone }: { label: string; pct: number; tone?: 'warning' | 'success' }) {
  return (
    <div
      className={tone ? `progress progress-${tone}` : 'progress'}
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
