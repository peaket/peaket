// 관제 경보 패널(d5 §3.3 '경보 패널 묶음', ADR-0069). 맨 위 SEV1 줄 → 이 회차 판단 → 플랫폼·위생·법정.
// 예산 SEV1 아래에는 억제된 같은 여정의 SEV2를 접힌 줄로 둔다('관련 경보 N건 접힘 · 알림은 보내지 않았습니다').
// 디자인 캔버스 SCR-029 보드의 '경보 패널' 위젯 마크업을 그대로 옮겼다. 위젯 틀(.widget)까지 그린다.
import type { CSSProperties, ReactNode } from 'react';
import { renderLinkOrAnchor, type RenderLink } from '../../lib/link';

export interface ConsoleAlertLink {
  label: string;
  href: string;
  /** Grafana·Sentry 같은 콘솔 밖 도구(새 탭, ↗ 아이콘) */
  external?: boolean;
  ariaLabel?: string;
}

export interface ConsoleAlert {
  id: string;
  /** 1·2·3, 또는 '버짓 100%' 같은 글자 배지 */
  sev: 1 | 2 | 3 | string;
  title: string;
  /** '20:03:41 KST' */
  at: string;
  /** ' · 31초 전 · 대응: 운영자 상황 판단' */
  meta?: string;
  /** 시각까지 굵지 않은 한 덩어리로 쓸 때(보드의 SEV1 줄) */
  metaOnly?: boolean;
  note?: string;
  links?: ConsoleAlertLink[];
  /** 바탕색: warning(기본, SEV2) · danger */
  tone?: 'warning' | 'danger';
}

export interface AlertPanelProps {
  /** 위젯 제목 id(보드: w-alert, w-lalert …) */
  id: string;
  title?: string;
  /** 비어 있으면 'SEV1 울리는 경보 없음' 줄 */
  sev1?: ConsoleAlert[];
  /** SEV1 아래 접힌 억제 경보(ADR-0069) */
  suppressed?: { count: number; detail: string };
  /** 고른 회차 묶음. null이면 그리지 않는다(활성 회차 없음) */
  event?: { title: string; alerts: ConsoleAlert[] } | null;
  /** 플랫폼·위생·법정 묶음 */
  platform: { alerts?: ConsoleAlert[]; sev3Summary?: { text: ReactNode; count: number; href: string } };
  /** 아래 '판단 순서' 한 줄 */
  footer?: ReactNode;
  allHref: string;
  style?: CSSProperties;
  renderLink?: RenderLink;
}

function Links({ links, renderLink }: { links?: ConsoleAlertLink[]; renderLink?: RenderLink }) {
  if (!links || links.length === 0) return null;
  return (
    <div className="row" style={{ gap: 12 }}>
      {links.map((l) =>
        l.external ? (
          <a key={l.label} className="link-more" href={l.href} target="_blank" rel="noreferrer" aria-label={l.ariaLabel}>
            {l.label}
            <i className="ic ic-external" aria-hidden="true" />
          </a>
        ) : (
          <span key={l.label} style={{ display: 'contents' }}>
            {renderLinkOrAnchor(renderLink, {
              href: l.href,
              className: 'link-more',
              'aria-label': l.ariaLabel,
              children: (
                <>
                  {l.label}
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </>
              ),
            })}
          </span>
        ),
      )}
    </div>
  );
}

function sevBadge(sev: ConsoleAlert['sev']) {
  if (sev === 1) {
    return (
      <span className="badge badge-danger">
        <i className="ic ic-alert-circle" aria-hidden="true" />
        SEV1
      </span>
    );
  }
  if (sev === 2) {
    return (
      <span className="badge badge-warning">
        <i className="ic ic-alert" aria-hidden="true" />
        SEV2
      </span>
    );
  }
  if (sev === 3) return <span className="badge">SEV3</span>;
  return (
    <span className="badge badge-danger">
      <i className="ic ic-alert-circle" aria-hidden="true" />
      {sev}
    </span>
  );
}

function AlertBody({ a, renderLink }: { a: ConsoleAlert; renderLink?: RenderLink }) {
  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        {sevBadge(a.sev)}
        <span className="t-sm fw-b">{a.title}</span>
      </div>
      <div className="row between wrap" style={{ gap: '4px 12px' }}>
        {a.metaOnly ? (
          <span className="t-xs muted num">
            {a.at}
            {a.meta}
          </span>
        ) : (
          <span className="t-xs">
            <span className="num">{a.at}</span>
            <span className="muted">{a.meta}</span>
          </span>
        )}
        <Links links={a.links} renderLink={renderLink} />
      </div>
      {a.note ? <span className="t-xs muted">{a.note}</span> : null}
    </>
  );
}

export function AlertPanel(props: AlertPanelProps) {
  const { id, renderLink } = props;
  const sev1 = props.sev1 ?? [];
  return (
    <section className="widget" role="region" aria-labelledby={id} style={props.style}>
      <div className="widget-head">
        <h2 className="t-sm fw-b" id={id}>
          {props.title ?? '경보 패널'}
        </h2>
        <div className="actions">
          {renderLinkOrAnchor(renderLink, {
            href: props.allHref,
            className: 'link-more',
            children: (
              <>
                경보 전체 목록
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </>
            ),
          })}
        </div>
      </div>
      <div className="widget-body">
        {sev1.length === 0 ? (
          <div
            className="row"
            role="group"
            aria-label="SEV1 경보"
            style={{ gap: 8, padding: '7px 8px', borderRadius: 6, boxShadow: 'inset 0 0 0 1px var(--border)' }}
          >
            <span className="badge badge-danger">SEV1</span>
            <span className="t-sm muted">울리는 경보 없음</span>
          </div>
        ) : (
          sev1.map((a) => (
            <div
              key={a.id}
              className="col"
              role="group"
              aria-label="SEV1 경보"
              style={{ gap: 6, padding: '7px 8px', borderRadius: 6, background: 'var(--danger-subtle)' }}
            >
              <AlertBody a={{ ...a, metaOnly: a.metaOnly ?? true }} renderLink={renderLink} />
              {props.suppressed ? (
                <details style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--surface)' }}>
                  <summary className="row t-xs" style={{ gap: 6, cursor: 'pointer', listStyle: 'none' }}>
                    <i className="ic ic-chevron-down ic-14" aria-hidden="true" />
                    <span className="fw-b">관련 경보 {props.suppressed.count}건 접힘 · 알림은 보내지 않았습니다</span>
                  </summary>
                  <p className="t-xs muted" style={{ padding: '6px 0 0 20px' }}>
                    {props.suppressed.detail}
                  </p>
                </details>
              ) : null}
            </div>
          ))
        )}
        {props.event ? (
          <div className="col" role="group" aria-labelledby={`${id}-ev`} style={{ gap: 6 }}>
            <h3 className="eyebrow" id={`${id}-ev`}>
              {props.event.title}
            </h3>
            <ul className="col" style={{ gap: 6 }}>
              {props.event.alerts.map((a) => (
                <li
                  key={a.id}
                  className="col"
                  style={{ gap: 4, padding: '7px 8px', borderRadius: 6, background: a.tone === 'danger' ? 'var(--danger-subtle)' : 'var(--warning-subtle)' }}
                >
                  <AlertBody a={a} renderLink={renderLink} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="col" role="group" aria-labelledby={`${id}-pf`} style={{ gap: 6 }}>
          <h3 className="eyebrow" id={`${id}-pf`}>
            플랫폼·위생·법정
          </h3>
          <ul className="col" style={{ gap: 6 }}>
            {(props.platform.alerts ?? []).map((a) => (
              <li
                key={a.id}
                className="col"
                style={{ gap: 4, padding: '7px 8px', borderRadius: 6, background: a.tone === 'danger' ? 'var(--danger-subtle)' : 'var(--warning-subtle)' }}
              >
                <AlertBody a={a} renderLink={renderLink} />
              </li>
            ))}
            {props.platform.sev3Summary ? (
              <li
                className="row between wrap"
                style={{ gap: '4px 12px', padding: '7px 8px', borderRadius: 6, boxShadow: 'inset 0 0 0 1px var(--border)' }}
              >
                <span className="row" style={{ gap: 8 }}>
                  <span className="badge">SEV3</span>
                  <span className="t-sm">{props.platform.sev3Summary.text}</span>
                </span>
                {renderLinkOrAnchor(renderLink, {
                  href: props.platform.sev3Summary.href,
                  className: 'link-more',
                  children: (
                    <>
                      {props.platform.sev3Summary.count}건 보기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </>
                  ),
                })}
              </li>
            ) : null}
          </ul>
        </div>
        {props.footer}
      </div>
    </section>
  );
}
