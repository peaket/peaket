// SCR-010 구매 세션 끝·세션 무효 안내(d5 §5.10). 버튼 없이 넘어가는 중 스피너를 두고 SCR-008 대기열로 자동으로 옮긴다(추천 적용 2026-10-28).
import { cx } from '@/shared/lib/cx';

export function GoneState({ kind }: { kind: 'ended' | 'invalid' }) {
  return (
    <>
      <h1 className="sr-only">좌석 선택</h1>
      <section className="state" role="alert" style={{ padding: '96px 24px 24px' }}>
        <span className="state-icon">
          <i className={cx('ic', kind === 'ended' ? 'ic-clock' : 'ic-device')} aria-hidden="true" />
        </span>
        <h2 className="t-lg">{kind === 'ended' ? '예매 시간이 끝났습니다' : '다른 탭에서 예매가 진행 중이거나 예매 세션이 끝났습니다'}</h2>
        <span className="spinner muted" aria-hidden="true" />
      </section>
    </>
  );
}
