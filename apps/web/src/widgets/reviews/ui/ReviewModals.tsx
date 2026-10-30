// SCR-016 후기 모달 위젯(공연 상세 SCR-002에 한 줄로 끼운다). 서버에서 주소(?state=·?reviews=·?review=·?report=)로 처음 모습을 정하고,
// 열 창이 없으면 아무것도 그리지 않는다. SCR-016 상태로 미리볼 때만 상태 고르기 패널을 왼쪽 아래에 둔다(SCR-002 패널은 오른쪽 아래).
import { getPerformance, listPerformances } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { SCR016_STATES } from '@/shared/config/screens.discovery';
import { firstParam, type SearchParams } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { resolveReviewModal } from '../model/view';
import { ReviewModalsClient } from './ReviewModalsClient';

export interface ReviewModalsProps {
  /** 회차 id(공연 상세 주소의 id) */
  eventId: string;
  searchParams: SearchParams;
  /** 로그인 전(쓰기·신고는 로그인 안내로 바뀐다) */
  guest: boolean;
}

/** ds StateSwitcher는 오른쪽 아래에 붙는다. 변형(transform)한 감싸개가 고정 위치의 기준이 되어 패널을 왼쪽 아래로 옮긴다 */
const LEFT_DOCK = { position: 'fixed', left: 0, bottom: 0, width: 284, height: 0, transform: 'translateZ(0)', zIndex: 2147483000 } as const;

export function ReviewModals({ eventId, searchParams, guest }: ReviewModalsProps) {
  const init = resolveReviewModal(searchParams, guest);
  if (!init) return null;
  const perf = getPerformance(eventId);
  const production = perf ? getProduction(perf.productionId) : undefined;
  const path = `/events/${eventId}`;
  const theme = firstParam(searchParams, 'theme') === 'dark' ? 'dark' : undefined;
  const rounds = production ? listPerformances(production.id).map((p) => ({ value: p.id, label: p.label })) : [];
  const key = [init.kind, init.reviewId, init.photo, init.from, init.preview ?? ''].join('|');
  return (
    <>
      <ReviewModalsClient
        key={key}
        init={init}
        path={path}
        theme={theme}
        guest={guest}
        title={production?.title ?? ''}
        rounds={rounds}
        currentRound={eventId}
        loginHref={`/login?next=${encodeURIComponent(path)}`}
      />
      {init.preview && process.env.NODE_ENV !== 'production' ? (
        <div style={LEFT_DOCK}>
          <PreviewSwitcher path={path} states={SCR016_STATES} current={init.preview} keep={{ theme }} />
        </div>
      ) : null}
    </>
  );
}
