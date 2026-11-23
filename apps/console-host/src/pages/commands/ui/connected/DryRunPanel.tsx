// 실행 전 모의(dry-run) 판(F-03-4 T1, C-T6 ②). control-tower §4 두 갈래: 센 값은 원천·센 시각과 함께, 예측 값은 식·넣은 값·가정과 함께.
// 세지 못한 값은 '세지 못함'과 까닭으로만 그리고 0이나 빈 숫자로 그리지 않는다. 모든 값은 글자로만 그린다(ASVS v5.0.0-1.2.1).
// 승인자도 접수 때 남긴 dry-run을 빼거나 더하지 않고 이 판으로 본다(d2 §3.5).
import type { DryRunView } from '../../model/dry-run';

export interface DryRunPanelProps {
  view: DryRunView | null;
  /** 이미 만든 문제 글(problems.ts) */
  error?: string;
}

const KST_TIME = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const num = (v: number) => (Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—');
const at = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${KST_TIME.format(new Date(t))} KST` : '—';
};

const APPROVAL_TEXT: Record<DryRunView['approval'], string> = {
  none: '승인 없이 바로 실행합니다(commander 1인)',
  one: '1인 실행입니다',
  two: '2인 승인입니다(요청자가 아닌 운영자가 승인해야 실행됩니다)',
};

export function DryRunPanel({ view, error }: DryRunPanelProps) {
  return (
    <section className="col" style={{ gap: 8 }} aria-label="실행 전 모의 결과">
      {error ? (
        <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
      {!view ? (
        error ? null : <p className="t-sm muted">칸을 모두 채우면 실행하면 무엇이 바뀌는지 미리 보입니다.</p>
      ) : (
        <>
          <p className="t-sm">
            {APPROVAL_TEXT[view.approval]}
            {view.reauth ? ' · 보내기 전에 다시 인증합니다' : ''}
          </p>
          {view.counted.length > 0 ? (
            <div>
              <h4 className="t-xs fw-b">지금 센 값</h4>
              <ul className="t-xs" style={{ margin: 0, paddingLeft: 16 }}>
                {view.counted.map((c) => (
                  <li key={c.key}>
                    {c.key}: {num(c.value)} · 원천 {c.source} · 센 시각 {at(c.measuredAt)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.predicted.length > 0 ? (
            <div>
              <h4 className="t-xs fw-b">예측 값(식으로 계산한 값)</h4>
              <ul className="t-xs" style={{ margin: 0, paddingLeft: 16 }}>
                {view.predicted.map((p) => (
                  <li key={p.key}>
                    <span className="fw-b">
                      {p.key}: {num(p.value)}
                    </span>
                    <span style={{ display: 'block' }}>식: {p.formula}</span>
                    {p.inputs.length > 0 ? <span style={{ display: 'block' }}>넣은 값: {p.inputs.map(([k, v]) => `${k} ${num(v)}`).join(', ')}</span> : null}
                    {p.assumptions.length > 0 ? <span style={{ display: 'block' }}>가정: {p.assumptions.join(' / ')}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.unavailable.length > 0 ? (
            <div>
              <h4 className="t-xs fw-b">세지 못한 값</h4>
              <ul className="t-xs" style={{ margin: 0, paddingLeft: 16 }}>
                {view.unavailable.map((u) => (
                  <li key={u.key}>
                    {u.key}: 세지 못함 · {u.reason} · 원천 {u.source}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.limits.length > 0 ? (
            <p className="t-xs muted">안전 한계: {view.limits.map(([k, v]) => `${k} ${num(v)}`).join(', ')}</p>
          ) : null}
        </>
      )}
    </section>
  );
}
