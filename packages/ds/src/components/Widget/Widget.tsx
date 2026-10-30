'use client';
// CMP-035 Widget. 관제 대시보드 위젯(캔버스 키트 20절 .widget). 보드 마크업:
//   <section class="widget" role="region" aria-labelledby="w-x"><div class="widget-head"><h2 class="t-sm fw-b" id="w-x">제목</h2>
//   <div class="actions"><span class="slo slo-ok">정상</span><a class="link-more" href>자세히 보기<i class="ic ic-chevron-right"></i></a></div></div>
//   <div class="widget-body">…</div></section>
// - status·statusText: 머리 오른쪽 상태 점과 글자(.slo). stale이면 '갱신 지연'(slo-stale)을 보인다.
// - moreHref: '자세히 보기' 링크. 바깥 도구(Grafana 등)면 moreExternal(새 탭, ic-external, 이름에 '새 탭').
// - collapsible: 접는 위젯 <details class="widget" open><summary class="widget-head">…<i class="ic ic-chevron-down fold-ic"></i></summary>.
//   접혀 있어도 요약(foldMeta)이 머리에 보인다.
// - error 또는 그리는 중 오류: 그 위젯만 오류 상태(.widget.is-error 점선 테두리 + ErrorState)로 바꾼다(위젯 단위 오류 경계, d2 CMP-035).
import { Component, useId, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';
import { ErrorState } from '../ErrorState/ErrorState';
import type { StatStatus } from '../StatTile/StatTile';

export interface WidgetProps {
  title: ReactNode;
  status?: StatStatus;
  statusText?: ReactNode;
  /** 머리 오른쪽에 더 둘 것(배지·버튼) */
  actions?: ReactNode;
  moreHref?: string;
  moreLabel?: string;
  moreExternal?: boolean;
  /** 갱신이 멈춘 상태 */
  stale?: boolean;
  staleText?: ReactNode;
  /** 이 위젯만 실패 */
  error?: ReactNode;
  onRetry?: () => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** 접는 위젯 머리의 요약 */
  foldMeta?: ReactNode;
  /** 본문 사이 간격(px). 키트 기본 10 */
  bodyGap?: number;
  bodyStyle?: CSSProperties;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

interface BoundaryProps {
  fallback: (error: Error) => ReactNode;
  children?: ReactNode;
}

class WidgetBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('위젯을 그리지 못했습니다', error, info.componentStack);
  }
  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function Widget({
  title,
  status,
  statusText,
  actions,
  moreHref,
  moreLabel = '자세히 보기',
  moreExternal = false,
  stale = false,
  staleText = '갱신 지연',
  error,
  onRetry,
  collapsible = false,
  defaultOpen = true,
  foldMeta,
  bodyGap,
  bodyStyle,
  className,
  style,
  children,
}: WidgetProps) {
  const titleId = `${useId()}-title`;
  const titleText = typeof title === 'string' ? title : undefined;
  const statusEl = stale ? (
    <span className="slo slo-stale">{staleText}</span>
  ) : statusText ? (
    <span className={cx('slo', `slo-${status ?? 'ok'}`)}>{statusText}</span>
  ) : null;
  const more = moreHref ? (
    <a
      className="link-more"
      href={moreHref}
      {...(moreExternal
        ? { target: '_blank', rel: 'noopener noreferrer', 'aria-label': titleText ? `${titleText} ${moreLabel}, 새 탭` : `${moreLabel}, 새 탭` }
        : titleText
          ? { 'aria-label': `${titleText} ${moreLabel}` }
          : null)}
    >
      {moreLabel}
      <Icon name={moreExternal ? 'external' : 'chevron-right'} />
    </a>
  ) : null;

  const failed = (content: ReactNode) => (
    <div className="widget-body">
      <ErrorState
        headingLevel={3}
        title={content ?? '이 위젯을 불러오지 못했습니다'}
        description="다른 위젯은 그대로 볼 수 있습니다."
        onRetry={onRetry}
        style={{ padding: '24px 16px' }}
      />
    </div>
  );
  const body = error ? (
    failed(error)
  ) : (
    <WidgetBoundary fallback={() => failed(null)}>
      <div className="widget-body" style={{ ...(bodyGap !== undefined ? { gap: bodyGap } : null), ...bodyStyle }} aria-busy={stale || undefined}>
        {children}
      </div>
    </WidgetBoundary>
  );

  if (collapsible) {
    return (
      <details className={cx('widget', error ? 'is-error' : undefined, className)} open={defaultOpen} style={style}>
        <summary className="widget-head">
          <span id={titleId}>{title}</span>
          <span className="fold-meta">
            {statusEl}
            {foldMeta}
            <Icon name="chevron-down" size={16} className="fold-ic" />
          </span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <section className={cx('widget', error ? 'is-error' : undefined, className)} role="region" aria-labelledby={titleId} style={style}>
      <div className="widget-head">
        <h2 className="t-sm fw-b" id={titleId}>
          {title}
        </h2>
        {statusEl || actions || more ? (
          <div className="actions">
            {statusEl}
            {actions}
            {more}
          </div>
        ) : null}
      </div>
      {body}
    </section>
  );
}
