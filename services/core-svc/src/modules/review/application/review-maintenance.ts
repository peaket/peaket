// review 정비 일(core-svc relay 프로세스의 정비 리더, platform MaintenanceRunner).
// - review-temp-block-expire(매일): 끝 시각이 지난 임시조치(RIGHTS_TEMP)를 풀고 조치 기록을 복원한다(정보통신망법 §44의2④, POL-044 ③).
// - review-purge-legacy(정비 시간 04:00~06:00 KST): 이전 판이 남긴 후기 행(작성자가 지웠는데 별점·지문·계정 ID가 남은 행, 옛 익명화로 참조만 끊긴 살아 있는 후기)을
//   지금 파기 칸으로 고친다(소유자 결정 2026-11-16 OPEN[42], ADR-0278, docs/data.md §2 '이전 판이 남긴 행 고치기', W8-audit2a 리뷰 A2).
//   id 차례 커서로 1,000행 [가정]씩 묶음마다 커밋하고, 멈춤 신호는 묶음 사이에 본다. 결과는 { purged, remaining }이고 다음 출시의 파기 행 CHECK·VALIDATE 전에 remaining 0이어야 한다.
import type { Clock, MaintenanceTask } from '@peaket/platform';
import type { ReviewStore } from '../domain/ports.js';
import { reviewImageDerivativeNames, reviewImagePublicKey } from '../domain/review-image.js';

/** 이전 판 행 고치기 한 묶음 1,000행 [가정](docs/data.md §2 '이전 판이 남긴 행 고치기') */
export const REVIEW_PURGE_LEGACY_BATCH = 1_000;

/** o.batch: 이전 판 행 고치기(review-purge-legacy)의 한 묶음 행 수(기본 1,000 [가정]) */
export function reviewMaintenanceTasks(store: ReviewStore, clock: Clock, o: { batch?: number; images?: { objects: { deletePublic(key: string): Promise<void> } } } = {}): MaintenanceTask[] {
  const batch = o.batch ?? REVIEW_PURGE_LEGACY_BATCH;
  const tasks: MaintenanceTask[] = [
    {
      name: 'review-temp-block-expire',
      when: 'daily',
      run: async () => {
        await store.expireTemporaryBlocks(clock.now());
      },
    },
    {
      name: 'review-purge-legacy',
      when: 'window',
      run: async (signal) => {
        let purged = 0;
        let after: string | undefined;
        // 커서가 없을 때(0건)까지 이어 부른다. 고친 수가 묶음보다 적어도 끝으로 보지 않는다(SKIP LOCKED로 덜 잡혔을 수 있다)
        while (!signal?.aborted) {
          const r = await store.purgeLegacyRows({ nowMs: clock.now(), limit: batch, ...(after === undefined ? {} : { after }) });
          purged += r.purged;
          if (r.last === undefined) break;
          after = r.last;
        }
        // 남은 대상 수를 잠그지 않고 센다(멈춤 신호로 끝났어도). 잠긴 행을 건너뛴 묶음이 '0행'으로 보이지 않게, 다음 출시의 조건은 remaining 0이다(웨이브 끝 정확성 리뷰 C2)
        const remaining = await store.countLegacyRows();
        return { purged, remaining };
      },
    },
  ];
  if (o.images) {
    tasks.push({
      name: 'review-image-cleanup',
      when: 'daily',
      run: async () => {
        const rows = await store.imageRowsDueForCleanup(clock.now(), 100);
        for (const row of rows) {
          for (const name of reviewImageDerivativeNames()) {
            try {
              await o.images!.objects.deletePublic(reviewImagePublicKey(row.imageId, name));
            } catch {
              // 남은 객체는 다음 정리가 같은 행으로 다시 본다
            }
          }
        }
        await store.deleteImageRows(rows.map((r) => r.imageId));
        return { removed: rows.length };
      },
    });
  }
  return tasks;
}
