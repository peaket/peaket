// F-04-16 운영 원천 재생 준비 상태. 파일 봉투·원천 대조를 통과한 뒤 F-04-17이 실제 재생 화면을 붙인다.
import { operatingSpec, type OpenTarget } from '../lib/operating';

const center = { flex: '1', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '80px 20px', textAlign: 'center' } as const;

export function ReadyMain({ target, byteLength }: { target: OpenTarget; byteLength: number }) {
  const spec = operatingSpec(target);
  return (
    <main id="main" role="status" aria-live="polite" className="col" style={center}>
      <h1 className="t-lg">{spec.title}</h1>
      <p className="t-md">{spec.badge} 원천 기록을 받았습니다.</p>
      <p className="t-sm muted num">{byteLength.toLocaleString('ko-KR')}바이트</p>
      <p className="t-xs muted">재생 화면을 준비하고 있습니다.</p>
    </main>
  );
}
