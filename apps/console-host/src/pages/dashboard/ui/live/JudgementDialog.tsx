// Go/No-Go 판정 대화상자(F-03-3 OPS-380, C-T25 ①, d5 §7.2 '[[ Go/No-Go 판정 ]] → 대화상자: 권고 실패 사유 { }, No-Go면 "입장 일시정지(명령 2)와 공지(명령 7)로 시작합니다"').
// 판정 값은 보내지 않는다: 서버가 항목을 다시 계산해 정한다(ASVS 8.2.3). 화면이 보내는 것은 실패한 권고 항목의 사유뿐이다.
import { useState } from 'react';
import { itemLabel, type Readiness } from './ReadinessChecklist';

export interface JudgementDialogProps {
  readiness: Readiness;
  /** [판정 기록]: 권고 사유를 넘긴다 */
  onSubmit?: (recommendedReasons: Record<string, string>) => void;
  onClose?: () => void;
  busy?: boolean;
  /** 서버가 거절한 까닭(문구) */
  error?: string;
}

export function JudgementDialog({ readiness, onSubmit, onClose, busy, error }: JudgementDialogProps) {
  const { preview } = readiness;
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const noGo = preview.verdict === 'no-go';
  const missing = preview.failedRecommended.filter((k) => !(reasons[k] ?? '').trim());
  return (
    <section className="widget" role="dialog" aria-modal="false" aria-labelledby="dlg-gng-title" style={{ gridColumn: '1 / -1' }}>
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="dlg-gng-title">
          {`Go/No-Go 판정 · 지금 결과 ${noGo ? 'No-Go' : 'Go'}`}
        </h2>
      </div>
      <form
        className="widget-body"
        style={{ gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length === 0) onSubmit?.(Object.fromEntries(preview.failedRecommended.map((k) => [k, (reasons[k] ?? '').trim()])));
        }}
      >
        {preview.failedRequired.length > 0 ? (
          <div className="col" style={{ gap: 4 }}>
            <h3 className="eyebrow">실패한 필수 항목</h3>
            <ul className="col t-sm">
              {preview.failedRequired.map((k) => (
                <li key={k}>{itemLabel(k)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {noGo ? <p className="t-sm fw-b">입장 일시정지(명령 2)와 공지(명령 7)로 시작합니다</p> : <p className="t-sm">필수 항목이 모두 통과했습니다. Go로 기록합니다.</p>}
        {preview.failedRecommended.map((k) => (
          <label key={k} className="col" style={{ gap: 4 }}>
            <span className="t-xs fw-b">{`권고 실패 사유 · ${itemLabel(k)}`}</span>
            <textarea className="input" rows={2} maxLength={500} required value={reasons[k] ?? ''} onChange={(e) => setReasons((r) => ({ ...r, [k]: e.target.value }))} />
          </label>
        ))}
        <p className="t-xs muted">판정은 서버가 지금 항목으로 다시 계산해 정하고, 판정과 사유는 감사 로그에 남습니다.</p>
        {error ? (
          <p className="t-xs" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline btn-sm" type="button" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || missing.length > 0}>
            판정 기록
          </button>
        </div>
      </form>
    </section>
  );
}
