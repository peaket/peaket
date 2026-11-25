// 감사 행 표(SCR-031, d5 §7.4): 시각·행위자·명령·사유·승인자·dry-run 결과·결과.
// 사유·행위자 이름은 텍스트 노드로만 그린다(ASVS 1.2.1). 행은 단추로 만들어 키보드로 고를 수 있게 한다.
import type { AuditRow } from '../../model/audit';

const APPROVAL: Record<AuditRow['dryRun']['approval'], string> = { none: '승인 없이 즉시', one: '1인', two: '2인', unknown: '—' };

export function dryRunSummary(row: AuditRow): string {
  const d = row.dryRun;
  return `${APPROVAL[d.approval]}${d.reauth ? ' · 재인증' : ''} · 센 값 ${d.counted} · 예측 ${d.predicted} · 세지 못함 ${d.unavailable}`;
}

function hhmmss(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function AuditTable({ rows, selectedId, onSelect }: { rows: readonly AuditRow[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (rows.length === 0) {
    return (
      <div className="state" role="status">
        <h3 className="t-md">이 기간에 기록이 없습니다</h3>
        <p className="t-sm muted">기간과 거르기를 넓혀 보세요.</p>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 6 }} role="list" aria-label="감사 기록">
      {rows.map((r) => (
        <button
          key={`${r.commandId}:${r.at}`}
          type="button"
          role="listitem"
          className="card-flat pad col"
          style={{
            gap: 4,
            textAlign: 'left',
            borderColor: r.commandId === selectedId ? 'var(--color-primary, #2563eb)' : undefined,
          }}
          aria-current={r.commandId === selectedId ? 'true' : undefined}
          onClick={() => onSelect(r.commandId)}
        >
          <span className="row between wrap" style={{ gap: 6 }}>
            <span className="t-sm">
              <span className="muted">{hhmmss(r.at)}</span> · <strong>{r.typeLabel}</strong>
            </span>
            <span className={`badge${r.state === 'FAILED' ? ' badge-danger' : r.state === 'ACKED' || r.state === 'SUCCEEDED' ? ' badge-success' : ' badge-primary'}`}>{r.result}</span>
          </span>
          <span className="t-sm">{r.reason || '사유 없음'}</span>
          <span className="t-xs muted">
            {r.actor}
            {r.actorRole && r.actorRole !== '—' ? `(${r.actorRole})` : ''} · 승인자 {r.approver} · {dryRunSummary(r)}
          </span>
        </button>
      ))}
    </div>
  );
}
