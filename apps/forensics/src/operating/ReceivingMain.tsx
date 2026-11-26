// F-04-16 운영 원천 받는 중 상태(d5 §7.17 '받는 중'). 기록을 받는 동안 좌석맵·타임라인은 그리지 않는다.
import { operatingSpec, type OpenTarget } from '../lib/operating';

const center = { flex: '1', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '80px 20px', textAlign: 'center' } as const;

export function ReceivingMain({ target }: { target: OpenTarget }) {
  const spec = operatingSpec(target);
  return (
    <main id="main" role="status" aria-live="polite" className="col" style={center}>
      <h1 className="t-lg">기록 받는 중</h1>
      <p className="t-sm muted">{spec.headerNote}</p>
      <div className="progress" role="progressbar" aria-label="기록 받는 중" aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: '62%' }} />
      </div>
      <p className="t-xs muted">받은 기록은 이 탭 메모리에만 두고 내려받지 않습니다.</p>
    </main>
  );
}
