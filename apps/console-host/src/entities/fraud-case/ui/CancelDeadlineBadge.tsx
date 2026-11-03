// 취소 마감까지 남은 시간 배지(CMP-040 DeadlineBadge cancel-deadline, d2 CMP-040). 12시간 [가정] 전부터 warning, 2시간 [가정] 전부터 danger.
// 색만으로 뜻을 말하지 않도록 남은 시간을 글자로 적는다. 글은 model.cancelDeadlineNotice가 만든다.
import { cancelDeadlineNotice } from '../model';

const TONE = { ok: '', warning: 'badge-warning', danger: 'badge-danger', passed: 'badge-danger' } as const;

export function CancelDeadlineBadge({ now, deadline, long = false }: { now: string; deadline: string; long?: boolean }) {
  const n = cancelDeadlineNotice(now, deadline);
  return (
    <span className={`badge ${TONE[n.tone]}`.trim()} data-tone={n.tone}>
      <i className={`ic ${n.tone === 'ok' ? 'ic-clock' : 'ic-alert'}`} aria-hidden="true" />
      {long ? n.text : <><span className="sr-only">취소 마감까지 </span>{n.short}</>}
    </span>
  );
}
