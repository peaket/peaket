// review 정비 일: 끝 시각이 지난 임시조치(RIGHTS_TEMP)를 풀고 조치 기록을 복원한다(정보통신망법 §44의2④, POL-044 ③).
// core-svc relay 프로세스의 정비 리더가 하루 한 번 돈다(platform MaintenanceRunner).
import type { Clock, MaintenanceTask } from '@peaket/platform';
import type { ReviewStore } from '../domain/ports.js';

export function reviewMaintenanceTasks(store: ReviewStore, clock: Clock): MaintenanceTask[] {
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
