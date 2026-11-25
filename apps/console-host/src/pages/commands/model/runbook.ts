// 파드 ack 시간 초과 때 보이는 런북 CLI 한 줄(C-T7 ③, F-03-7).
// 정본: docs/features/control-tower.md §5 '제어 평면 Degraded Mode'의 `peaket-runbook draft <명령 유형> --event <회차 ID> [--param 키=값] --reason "<사유>" [--command-id <명령 ID>] --out <파일>`.
// 화면은 채운 한 줄을 보여 주기만 하고 실행하지 않는다. 사유의 따옴표·역슬래시·줄바꿈은 한 줄로 막는다.

export function runbookLineOf(d: { commandId?: string | null; type?: string | null; eventId?: string | null; reason?: string | null }): string | null {
  if (!d.commandId || !d.type) return null;
  const reason = (d.reason ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  const parts = ['peaket-runbook', 'draft', d.type];
  if (d.eventId) parts.push('--event', d.eventId);
  parts.push('--reason', `"${reason}"`, '--command-id', d.commandId, '--out', `${d.commandId}.json`);
  return parts.join(' ');
}
