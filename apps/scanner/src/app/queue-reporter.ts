// 큐 비움 보고 앱 조립(offline-gate §7.3 '큐 비움 보고' 끝, docs/review/plans/F-05-12.md §3 결정 7).
// 첫 근무 준비와 1건 이상에서 0건이 된 순간에만 PUT하고, 0건이 이어지면 보내지 않는다.
// 실패는 삼키고(근무 준비 화면을 막지 않는다) 다음 0건/재연결에서 다시 시도한다.
import { queueReportDue } from '../api/live.ts';

export interface QueueReporterDeps {
  api: { queueReport(eventId: string, pendingUploads: number): Promise<void> };
  /** shift(근무 회차)의 eventId. 모르면 보내지 않는다 */
  eventId: () => string | undefined;
}

export class QueueReporter {
  #emptyReported = false;
  readonly #d: QueueReporterDeps;

  constructor(d: QueueReporterDeps) {
    this.#d = d;
  }

  async reportFirstReady(pendingUploads: number): Promise<void> {
    const eventId = this.#d.eventId();
    if (!eventId) return;
    try {
      await this.#d.api.queueReport(eventId, pendingUploads);
      this.#emptyReported = pendingUploads === 0;
    } catch {
      // 실패는 삼킨다. 다음 0건에서 다시 보낸다
      if (pendingUploads > 0) this.#emptyReported = false;
    }
  }

  async note(i: { previousPending: number; nextPending: number }): Promise<void> {
    if (i.nextPending > 0) {
      this.#emptyReported = false;
      return;
    }
    if (!queueReportDue({ previousPending: i.previousPending, nextPending: i.nextPending, emptyReported: this.#emptyReported })) return;
    const eventId = this.#d.eventId();
    if (!eventId) return;
    try {
      await this.#d.api.queueReport(eventId, 0);
      this.#emptyReported = true;
    } catch {
      this.#emptyReported = false;
    }
  }
}
