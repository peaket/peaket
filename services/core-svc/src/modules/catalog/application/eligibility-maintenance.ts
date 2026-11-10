// 유스케이스: 판매 자격 명단 정비 일 둘(ADR-0261 결정 7·9·13, BUILD_ORDER HOT-250). core-svc relay 프로세스의 정비 리더가 하루 한 번 돈다(platform MaintenanceRunner).
// 정비 역할(core_maintenance) 연결로 모든 테넌트의 명단을 다룬다.
// - sale-eligibility-purge: 파기 시각(destroy_due_at) ≤ 지금인 명단의 구성원을 5,000행 [가정]씩 지우고 명단 행을 지우며 지운 기록(새 사본 판)을 남긴 뒤 사본 지우기를 넘긴다.
//   DB 행은 파기 시각이 지난 뒤 첫 정비에 지워진다(하루 [가정]까지 늦을 수 있다). 사본 지우기가 하나라도 실패하면 일을 실패로 끝낸다(지운 기록은 남아 다음 정비가 다시 지운다, 리뷰 S1).
//   두 시간 [가정] 지난 올리기 기록도 지운다(리뷰 S5).
// - sale-eligibility-copy: 지운 기록의 사본 지우기를 다시 하고, 넘긴 판(copied_seq)이 사본 판(copy_seq)보다 작은 명단(파기 시각 전)을 다시 넘긴다. 회차·수명은 넘기는 지금의
//   규칙·회차로 계산한다(리뷰 H1). 하나라도 못 넘기면 일을 실패로 끝내 정비 실패 지표에 남긴다. 사본을 쓰는 쪽이 이어지지 않았으면 구성원을 읽지 않고 넘길 수만 센다(리뷰 C1).
// 넘기지 못한 명단과 다시 지울 기록의 수를 sale_eligibility_copy_pending으로 낸다(리뷰 C2). 기록에는 명단 수·판·결과만 싣고 구성원 계정 ID는 넣지 않는다.
import type { Clock, MaintenanceTask } from '@peaket/platform';
import type { SaleEligibilityCopy } from '../domain/eligibility-ports.js';
import { MEMBER_CHUNK, UPLOAD_LOG_KEEP_MS } from '../domain/sale-eligibility.js';
import type { SaleMaintenanceStore } from '../domain/sale-ports.js';
import { SaleEligibilityMetrics } from './sale-eligibility-metrics.js';

/** 한 번에 읽는 명단 수 [가정] */
const LIST_BATCH = 100;

type Log = { info?(o: object, msg?: string): void; warn(o: object, msg?: string): void };

export function saleEligibilityMaintenanceTasks(store: SaleMaintenanceStore, copy: SaleEligibilityCopy, clock: Clock, logger?: Log, metrics: SaleEligibilityMetrics = new SaleEligibilityMetrics()): MaintenanceTask[] {
  const warn = (o: object, msg: string) => {
    try {
      logger?.warn(o, msg);
    } catch {
      // 기록 실패는 정비를 바꾸지 않는다
    }
  };
  const pendingCount = async () => {
    const n = (await store.countPendingCopies(new Date(clock.now()))) + (await store.countPendingDrops());
    metrics.pending(n);
    return n;
  };
  /** 지운 기록 하나의 사본 지우기(성공하면 기록을 지운다). 실패하면 false */
  const dropOne = async (d: { productionId: string; listKey: string; copySeq: number }, eventIds?: string[]): Promise<boolean> => {
    try {
      await copy.drop({ eventIds: eventIds ?? (await store.dropEventIds(d.productionId)), listKey: d.listKey, version: d.copySeq });
      await store.dropDone(d);
      metrics.copy('ok');
      return true;
    } catch (e) {
      metrics.copy('failed');
      warn({ event: 'sale_eligibility_copy_failed', op: 'drop', productionId: d.productionId, listKey: d.listKey, copySeq: d.copySeq, err: (e as Error).name }, '판매 자격 명단 사본 지우기를 넘기지 못했다(다음 정비가 다시 지운다)');
      return false;
    }
  };
  return [
    {
      name: 'sale-eligibility-purge',
      when: 'daily',
      run: async (signal) => {
        let purged = 0;
        let dropFailed = 0;
        const uploadsDeleted = await store.deleteUploadsBefore(new Date(clock.now() - UPLOAD_LOG_KEEP_MS));
        const skipped = new Set<string>();
        for (;;) {
          if (signal?.aborted) break;
          const due = (await store.dueForPurge(new Date(clock.now()), LIST_BATCH + skipped.size)).filter((l) => !skipped.has(l.id));
          if (due.length === 0) break;
          for (const l of due) {
            if (signal?.aborted) break;
            const out = await store.purge(l, new Date(clock.now()), MEMBER_CHUNK, signal);
            if (!out) {
              // 그 사이 파기 시각이 늦춰졌다(다음 정비가 다시 본다)
              skipped.add(l.id);
              continue;
            }
            purged++;
            // 사본을 쓰는 쪽이 없으면 지운 기록만 남긴다(사본 정비가 수를 센다)
            if (copy.connected && !(await dropOne({ productionId: l.productionId, listKey: l.key, copySeq: out.copySeq }, out.eventIds))) dropFailed++;
          }
        }
        await pendingCount();
        if (dropFailed > 0) throw new Error(`파기한 판매 자격 명단 ${purged}개 가운데 사본 지우기 ${dropFailed}개를 넘기지 못했다`);
        return { purged, dropFailed, uploadsDeleted };
      },
    },
    {
      name: 'sale-eligibility-copy',
      when: 'daily',
      run: async (signal) => {
        if (!copy.connected) {
          // 쓰는 쪽이 정해지지 않았다: 50만 행 구성원을 읽지 않고 넘길 수만 지표로 낸다(리뷰 C1·D5)
          const pending = await pendingCount();
          warn({ event: 'sale_eligibility_copy_unwired', pending }, '판매 자격 명단 사본을 쓰는 쪽이 정해지지 않아 넘기지 않았다');
          return { unwired: true, pending };
        }
        let copied = 0;
        let dropped = 0;
        let failed = 0;
        const triedDrops = new Set<string>();
        for (;;) {
          if (signal?.aborted) break;
          const drops = (await store.pendingDrops(LIST_BATCH + triedDrops.size)).filter((d) => !triedDrops.has(`${d.productionId}:${d.listKey}:${d.copySeq}`));
          if (drops.length === 0) break;
          for (const d of drops) {
            if (signal?.aborted) break;
            triedDrops.add(`${d.productionId}:${d.listKey}:${d.copySeq}`);
            if (await dropOne(d)) dropped++;
            else failed++;
          }
        }
        const tried = new Set<string>();
        for (;;) {
          if (signal?.aborted) break;
          const pending = (await store.pendingCopies(new Date(clock.now()), LIST_BATCH + tried.size)).filter((l) => !tried.has(`${l.id}:${l.copySeq}`));
          if (pending.length === 0) break;
          for (const l of pending) {
            if (signal?.aborted) break;
            tried.add(`${l.id}:${l.copySeq}`);
            const data = await store.copyData(l);
            if (!data) continue;
            try {
              await copy.put({ productionId: l.productionId, eventIds: data.eventIds, listKey: l.key, version: l.copySeq, accountIds: data.accountIds, expiresAt: data.expiresAt });
              await store.markCopied(l.id, l.copySeq);
              metrics.copy('ok');
              copied++;
            } catch (e) {
              metrics.copy('failed');
              failed++;
              warn({ event: 'sale_eligibility_copy_failed', op: 'put', productionId: l.productionId, listKey: l.key, copySeq: l.copySeq, err: (e as Error).name }, '판매 자격 명단 사본을 다시 넘기지 못했다');
            }
          }
        }
        await pendingCount();
        if (failed > 0) throw new Error(`판매 자격 명단 사본 ${failed}개를 넘기지 못했다`);
        return { copied, dropped };
      },
    },
  ];
}
