// 감사 체인·공개 앵커 띠(SCR-031, d5 §7.4). 부르는 쪽이 만든 ChainView만 그린다(서버 그리기 시험).
import type { ChainView } from '../../model/audit';

const TONE: Record<ChainView['kind'], string> = {
  empty: 'banner-info',
  verified: 'banner-info',
  pending: 'banner-warning',
  late: 'banner-warning',
  broken: 'banner-danger',
};

export function ChainBanner({ chain }: { chain: ChainView }) {
  if (chain.kind === 'verified' && chain.anchor === 'none') {
    return (
      <div className="banner banner-info" role="status">
        <div className="banner-body">
          <span className="badge badge-success">감사 체인 검증됨</span> 마지막 공개 체크포인트 {chain.lastNo !== null ? `#${chain.lastNo}` : '—'}
        </div>
      </div>
    );
  }
  const tone = chain.anchor === 'late' && chain.kind !== 'broken' ? 'banner-danger' : TONE[chain.kind];
  return (
    <div className={`banner ${tone}`} role={chain.kind === 'broken' || chain.anchor === 'late' ? 'alert' : 'status'}>
      <div className="banner-body">
        <span className={`badge${chain.kind === 'broken' ? ' badge-danger' : chain.kind === 'verified' ? ' badge-success' : ' badge-warning'}`}>
          {chain.kind === 'broken' ? '체인 변조' : chain.kind === 'verified' ? '감사 체인 검증됨' : chain.kind === 'empty' ? '기록 없음' : '검증 대기'}
        </span>{' '}
        {chain.message}
      </div>
    </div>
  );
}
