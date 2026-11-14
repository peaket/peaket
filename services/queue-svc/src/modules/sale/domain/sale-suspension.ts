// 판매 승인 업무의 판매 중지·재개의 대기열 사본(ADR-0123, docs/features/queue-admission.md §4, docs/data.md q:{event:E}:notice·ctl).
// purchase-svc가 원본(sale_control)을 쓴 뒤 ops-svc가 이 경로를 부른다. 여기서는 사본만 쓴다.
// 대기 상태 파일은 notice.suspended를 읽어 saleStatus를 PAUSED로 만들고, 리더는 ctl.suspended를 읽어 serving 전진을 멈춘다.

export const SALE_SUSPENSION_ACTIONS = ['SUSPEND', 'RESUME'] as const;
export type SaleSuspensionAction = (typeof SALE_SUSPENSION_ACTIONS)[number];

export interface SaleSuspensionCopyWrite {
  readonly eventId: string;
  readonly suspended: boolean;
  /** purchase-svc 원본의 판 번호(사본의 suspRev). 모르면 0 */
  readonly revision: number;
  readonly commandId: string;
}

export const SALE_SUSPENSION_COPIES = Symbol('queue.SaleSuspensionCopies');
/** 대기열 사본 쓰기. 실패하면 던진다(명령은 FAILED로 남고 재시도가 다시 쓴다) */
export interface SaleSuspensionCopies {
  /** q:{event:E}:notice와 q:{event:E}:ctl에 suspended('1'·'0')·suspRev·suspCmd를 쓴다. 다른 칸은 건드리지 않는다 */
  write(c: SaleSuspensionCopyWrite): Promise<void>;
}
