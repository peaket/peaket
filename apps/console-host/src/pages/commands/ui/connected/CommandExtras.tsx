// 명령 화면 위 줄의 효과 줄·걸린 자동 조치·자동 조절 복귀 확인(F-03-7).
// 값이 없으면 0이 아니라 '원천 연결 전'으로 둔다. 복귀 확인 단추는 서버 경로가 없어 비활성이다.
import type { EffectRow } from '../../model/command-effects';
import type { AutoActionRow } from '../../model/auto-actions';

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function EffectStrip({ rows }: { rows: readonly { type: string; row: EffectRow }[] }) {
  const visible = rows.filter((r) => r.row.visible);
  if (visible.length === 0) return null;
  return (
    <section className="banner banner-info" role="status" aria-label="적용 중 명령 효과">
      <div className="banner-body col" style={{ gap: 4 }}>
        <strong className="t-sm">적용 중 명령 효과(10분)</strong>
        {visible.map(({ type, row }) => (
          <span key={type} className="t-xs">
            {type === 'BLOCK_ASN_IP' ? '대역 차단' : '봇 판정 강도'} ·{' '}
            {row.kind === 'source-unavailable' ? (
              '원천 연결 전(값 없음)'
            ) : (
              <>
                차단 비율 {pct(row.blockedRatio!.before)} → {pct(row.blockedRatio!.after)} · 추가 검증 통과율 {pct(row.passRate!.before)} → {pct(row.passRate!.after)} · 이의 {row.objections!.before} → {row.objections!.after}
              </>
            )}
            {row.warn ? ` · SEV2: ${row.warnReason === 'passed-rate-drop' ? '추가 검증 통과율이 10%p 넘게 떨어졌습니다' : '이의 제기가 5건을 넘었습니다'}` : ''}
          </span>
        ))}
      </div>
    </section>
  );
}

export function AutoActionStrip({ stuck, recentlyCleared, unavailable, message }: { stuck: readonly AutoActionRow[]; recentlyCleared: readonly AutoActionRow[]; unavailable: boolean; message: string }) {
  if (unavailable && stuck.length === 0 && recentlyCleared.length === 0) {
    return (
      <section className="banner banner-info" role="status" aria-label="걸린 자동 조치">
        <div className="banner-body t-sm">걸린 자동 조치 · {message}</div>
      </section>
    );
  }
  return (
    <section className="banner banner-info" role="status" aria-label="걸린 자동 조치">
      <div className="banner-body col" style={{ gap: 4 }}>
        <strong className="t-sm">걸린 자동 조치 {stuck.length}건</strong>
        {stuck.map((a) => (
          <span key={`${a.name}:${a.target}`} className="t-xs">
            {a.name}
            {a.target ? ` · ${a.target}` : ''} · {a.state}
            {a.progress ? ` · ${Math.round(a.progress.ratio * 100)}% (남은 ${Math.round(a.progress.remainingMs / 1000)}초)` : ''}
          </span>
        ))}
        {recentlyCleared.length > 0 ? <span className="t-xs muted">최근 풀림: {recentlyCleared.map((a) => a.name).join(', ')}</span> : null}
      </div>
    </section>
  );
}

export function AutoResumeDialog({ open, why, onClose }: { open: boolean; why: string | null; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog col" role="alertdialog" aria-modal="true" aria-labelledby="auto-resume-h" aria-describedby="auto-resume-d" style={{ maxWidth: 480, gap: 10 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title" id="auto-resume-h">자동 조절 복귀 확인</h2>
        <p className="t-sm" id="auto-resume-d">입력 없음이 풀렸습니다. 확인해야 자동 증액이 다시 시작됩니다.</p>
        {why ? <p className="hint">{why}</p> : null}
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose}>닫기</button>
          <button className="btn btn-primary" type="button" disabled aria-disabled="true" title={why ?? undefined}>확인</button>
        </div>
      </div>
    </div>
  );
}
