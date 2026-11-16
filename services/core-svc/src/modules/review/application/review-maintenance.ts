// review 정비 일: 끝 시각이 지난 임시조치(RIGHTS_TEMP)를 풀고 조치 기록을 복원한다(정보통신망법 §44의2④, POL-044 ③).
// core-svc relay 프로세스의 정비 리더가 하루 한 번 돈다(platform MaintenanceRunner).
import type { Clock, MaintenanceTask } from '@peaket/platform';
import type { ReviewStore } from '../domain/ports.js';

/**
 * o.batch: 이전 판 행 고치기(review-purge-legacy)의 한 묶음 행 수(기본 1,000 [가정]).
 * 뼈대(W8-audit2a 리뷰 A2 시험 단계): 인자만 더했다. 정비 일 review-purge-legacy(when 'window')는 구현 담당이 더한다
 */
export function reviewMaintenanceTasks(store: ReviewStore, clock: Clock, _o: { batch?: number } = {}): MaintenanceTask[] {
  return [
    {
      name: 'review-temp-block-expire',
      when: 'daily',
      run: async () => {
        await store.expireTemporaryBlocks(clock.now());
      },
    },
  ];
}
