// F-04-16 운영 원천 머리(CMP-082, d5 §7.17). 원천 배지·회차·사건(조사)·관제 콘솔 링크·격리 상태 띠를 보인다.
import { ReplaySourceBadge } from '@peaket/ds/ReplaySourceBadge';
import { isolationLabel, operatingSpec, type OpenTarget } from '../lib/operating';

export function OperatingHead({ target }: { target: OpenTarget }) {
  const spec = operatingSpec(target);
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  return (
    <header className="row between" style={{ gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      <div className="row" style={{ gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
        <ReplaySourceBadge source={target.sourceLabel} />
        <span className="sep" aria-hidden="true" />
        <span className="fw-b">{spec.event}</span>
        {spec.caseLabel ? <span className="mono">{spec.caseLabel}</span> : null}
        <span className="mono t-xs muted">{spec.window}</span>
        {spec.headerNote ? <span className="t-xs muted">{spec.headerNote}</span> : null}
        <h1 className="sr-only">{spec.title}</h1>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <span role="status" aria-live="polite" className="t-xs muted">
          {isolationLabel(isolated)}
        </span>
        <a className="link-more" href={spec.consolePath ?? '/dashboard'}>
          관제 콘솔
        </a>
      </div>
    </header>
  );
}
