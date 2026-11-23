// 실제 값 경보 패널(F-03-3 OPS-380, C-T32 ②③④, docs/features/control-tower.md §8, d5 §7.2 '경보 억제', docs/frontend.md §5.7, ASVS 1.2.2·3.7.2).
// 호스트 alerts 슬라이스를 '이 회차 판단'과 '플랫폼·위생·법정'으로 나누고(groupAlerts), 위 경보 아래에 접힌 경보를 한 줄로 보인다.
// 런북·대시보드·실패 사건 보기 주소는 허용 호스트의 https일 때만 새 탭 링크이고 아니면 글자로만 보인다(자동 이동 없음).
// 줄이 50줄 [가정]을 넘으면 줄 높이를 고정한 창 그리기로 보이는 줄만 DOM에 두고, 전체 수·위치는 aria-setsize·aria-posinset으로 알린다(새 의존성 없이).
import { useState, type CSSProperties, type ReactNode } from 'react';
import { safeAlertHref, NEW_TAB } from '@/shared/lib/links';
import type { LiveAlert } from '@/shared/model/live-host';
import { groupAlerts, type AlertRow } from '../../model/alert-groups';
import { kst } from './frame';

/** 이 줄 수를 넘으면 보이는 줄만 그린다 [가정] */
export const ALERT_VIRTUAL_AFTER = 50;
/** 고정 줄 높이(px)와 창 높이(px) [가정] */
const ROW_PX = 72;
const VIEW_PX = 576;
const OVERSCAN = 3;

const SEV_BADGE: Record<string, string> = { SEV1: 'badge badge-danger', SEV2: 'badge badge-warning', SEV3: 'badge' };

function AlertLink({ label, url, aria }: { label: string; url: string | undefined; aria: string }) {
  if (!url) return null;
  const href = safeAlertHref(url);
  if (!href) {
    // 허용 밖 주소는 글자로만(주소도 보이지 않는다)
    return (
      <span className="t-xs muted" title="허용하지 않은 주소라 열지 않습니다">
        {label}
      </span>
    );
  }
  return (
    <a className="link-more" href={href} {...NEW_TAB} aria-label={`${aria}, 새 탭`}>
      {label}
      <i className="ic ic-external" aria-hidden="true" />
    </a>
  );
}

function AlertLine({ row, style, pos, size }: { row: AlertRow; style?: CSSProperties; pos: number; size: number }) {
  const a = row.alert;
  const resolved = a.status !== 'firing';
  return (
    <li className="col" role="listitem" aria-posinset={pos} aria-setsize={size} style={{ gap: 4, padding: '7px 8px', borderRadius: 6, boxShadow: 'inset 0 0 0 1px var(--border)', ...style }}>
      <span className="row wrap" style={{ gap: '4px 8px' }}>
        <span className={SEV_BADGE[a.severity] ?? 'badge'}>{a.severity}</span>
        <span className={resolved ? 't-sm muted' : 't-sm fw-b'}>{a.title}</span>
        <span className="t-xs muted num">{`${kst(a.startsAt)}${resolved ? ` · 풀림 ${kst(a.endsAt)}` : ''}`}</span>
        <span className="row" style={{ gap: 10 }}>
          <AlertLink label="런북" url={a.runbookUrl} aria={`${a.title} 런북`} />
          <AlertLink label="대시보드" url={a.dashboardUrl} aria={`${a.title} 대시보드`} />
          <AlertLink label="실패 사건 보기" url={a.exploreUrl} aria={`${a.title} 실패 사건 보기`} />
        </span>
      </span>
      {row.folded.length > 0 ? (
        <span className="t-xs muted" title={row.folded.map((f) => f.title).join(' · ')}>
          {`관련 경보 ${row.folded.length}건 접힘 · 알림은 보내지 않았습니다`}
        </span>
      ) : null}
    </li>
  );
}

function AlertList({ rows, label, virtual }: { rows: AlertRow[]; label: string; virtual: boolean }) {
  const [top, setTop] = useState(0);
  if (rows.length === 0) {
    return <p className="t-sm muted">울리는 경보 없음</p>;
  }
  if (!virtual) {
    return (
      <ul className="col" role="list" aria-label={label} style={{ gap: 6 }}>
        {rows.map((r, i) => (
          <AlertLine key={r.alert.alertId} row={r} pos={i + 1} size={rows.length} />
        ))}
      </ul>
    );
  }
  const first = Math.max(0, Math.floor(top / ROW_PX) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + VIEW_PX) / ROW_PX) + OVERSCAN);
  const shown: ReactNode[] = [];
  for (let i = first; i < last; i += 1) {
    const r = rows[i]!;
    shown.push(<AlertLine key={r.alert.alertId} row={r} pos={i + 1} size={rows.length} style={{ position: 'absolute', top: i * ROW_PX, left: 0, right: 0, height: ROW_PX - 6, overflow: 'hidden' }} />);
  }
  return (
    <div style={{ maxHeight: VIEW_PX, overflowY: 'auto' }} onScroll={(e) => setTop(e.currentTarget.scrollTop)} tabIndex={0} aria-label={`${label} ${rows.length}건(스크롤)`}>
      <ul role="list" aria-label={label} style={{ position: 'relative', height: rows.length * ROW_PX, margin: 0 }}>
        {shown}
      </ul>
    </div>
  );
}

export function LiveAlertPanel({ alerts, eventId, style }: { alerts: readonly LiveAlert[]; eventId: string | null | undefined; style?: CSSProperties }) {
  const g = groupAlerts(alerts, eventId);
  const virtual = g.event.length + g.platform.length > ALERT_VIRTUAL_AFTER;
  return (
    <section className="widget" role="region" aria-labelledby="w-alert-h" id="w-alert" style={style}>
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="w-alert-h">
          경보 패널
        </h2>
        <span className="t-xs muted">{`SEV1 ${g.counts.sev1} · SEV2 ${g.counts.sev2} · SEV3 ${g.counts.sev3}`}</span>
      </div>
      <div className="widget-body" style={{ gap: 10 }}>
        <div className="col" role="group" aria-labelledby="w-alert-ev" style={{ gap: 6 }}>
          <h3 className="eyebrow" id="w-alert-ev">
            이 회차 판단
          </h3>
          <AlertList rows={g.event} label="이 회차 판단 경보" virtual={virtual} />
        </div>
        <div className="col" role="group" aria-labelledby="w-alert-pf" style={{ gap: 6 }}>
          <h3 className="eyebrow" id="w-alert-pf">
            플랫폼·위생·법정
          </h3>
          <AlertList rows={g.platform} label="플랫폼·위생·법정 경보" virtual={virtual} />
        </div>
      </div>
    </section>
  );
}
