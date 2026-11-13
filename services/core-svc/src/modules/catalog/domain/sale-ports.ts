// 도메인 층: 판매 정책 규칙·회차 고치기·판매 자격 명단의 저장소 포트(ADR-0261 결정 1·2·4·6~9, docs/data.md §5 경합 줄). 어댑터가 구현한다.
// 파트너 경로는 행 보안 대상 사용자(core_partner)로 접속하고 트랜잭션에 테넌트를 건다. 조회에도 테넌트 조건을 넣는다(범위 인자, 행 보안은 2차 방어).
// 쓰기는 공연 행을 FOR NO KEY UPDATE로 잡은 트랜잭션(등록·이미지·좌석맵과 같은 잠금) 안에서 한다.
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import type { EventStatus, SaleReview } from './production.js';
import type { SaleApprovalInput } from './sale-approval.js';
import type { PendingEvent } from './registration.js';

/** 회차 고치기로 바꿀 수 있는 칸(openapi PartnerEventUpdate) */
export interface EventEditable {
  openAt: Date;
  lobbyMinutes: number;
  entryOpensAt: Date | null;
  startsAt: Date;
  endsAt: Date;
  lobbyShuffle: boolean;
  openBatch: boolean;
  seatAssignment: 'PICK' | 'AUTO';
  perPersonLimit: number;
}

/** event 행 하나(공개본 값)와 판 */
export interface SaleEventRow extends EventEditable {
  eventId: string;
  status: EventStatus;
  version: number;
  /** 공연의 배치본(승인 전에는 없을 수 있다) */
  venueId?: string | null;
  /** 판매 승인 때 정한 공연 규모(회차 칸, ADR-0093). 승인 전에는 없다 */
  scale?: 'LARGE' | 'MEDIUM' | 'SMALL';
}

/** 저장한 명단 정보(구성원은 싣지 않는다) */
export interface StoredList {
  id: string;
  key: string;
  name: string;
  memberCount: number;
  version: number;
  /** 사본 판(전역 순번, 사본에 닿는 일마다 새 번호, 리뷰 H1) */
  copySeq: number;
  /** 사본으로 넘긴 마지막 판(못 넘겼으면 copySeq보다 작거나 NULL) */
  copiedSeq: number | null;
  uploadedAt: Date;
  lockedAt: Date | null;
  destroyDueAt: Date;
}

/** 잠근 공연에서 읽은 판매 상태 */
export interface SaleState {
  production: {
    id: string;
    promoterId: string;
    saleReview: SaleReview;
    saleApprovedAt: Date | null;
    /** production.sale_policy(승인 이력이 있으면 마지막 승인 내용) */
    rules: SalePolicyRule[];
    /** pending_revision.salePolicy(재승인 대기 변경분의 규칙). 없으면 undefined */
    pendingRules: SalePolicyRule[] | undefined;
    salePolicyVersion: number;
  };
  /** event 행(공개본) */
  events: SaleEventRow[];
  /** pending_revision.eventChanges(회차 ID → 바뀐 칸만) */
  eventChanges: Record<string, Partial<EventEditable>>;
  /** 승인 뒤 더한 회차(변경분) */
  addedEvents: PendingEvent[];
  /** 지금 배치본의 등급 ID(재승인 대기 판이 있으면 그 판의 것) */
  grades: string[];
  lists: StoredList[];
}

/** 명단 행 쓰기(같은 키면 그 행을 고친다) */
export interface ListWrite {
  id: string;
  key: string;
  name: string;
  memberCount: number;
  fileSha256: Uint8Array;
  version: number;
  uploadedAt: Date;
  uploadedBy: string;
  lockedAt: Date | null;
  destroyDueAt: Date;
}

export interface SaleTx {
  state(): Promise<SaleState>;
  /** from~to의 공개 중인 다른 공연 회차 오픈 시각(회차 더하기와 같은 판정, ADR-0198 결정 2) */
  otherOpenTimes(from: Date, to: Date, excludeProductionId: string): Promise<Date[]>;
  /**
   * 규칙을 판과 함께 쓴다. rows: production.sale_policy를 바로 고친다(승인 이력 없음). pending: pending_revision.salePolicy에만 두고 판매 승인 상태를 바꾼다
   */
  saveRules(rules: SalePolicyRule[], version: number, where: 'rows' | 'pending', saleReview: SaleReview): Promise<void>;
  /** 승인 이력이 없는 공연: event 행의 칸과 판을 고친다 */
  updateEvent(eventId: string, patch: Partial<EventEditable>, version: number): Promise<void>;
  /** 승인 이력이 있는 공연: event 행은 판만 올리고 바뀐 칸을 pending_revision.eventChanges[회차 ID]에 합쳐 두며 판매 승인 상태를 바꾼다 */
  savePendingEventChange(eventId: string, changes: Partial<EventEditable>, version: number, saleReview: SaleReview): Promise<void>;
  /** 명단의 잠금·파기 시각을 고친다 */
  setListTimes(listId: string, lockedAt: Date | null, destroyDueAt: Date): Promise<void>;
  /** 그 공연 명단 모두에 새 사본 판을 매긴다(규칙 저장·회차 고치기처럼 사본의 회차·수명이 바뀌는 일, 리뷰 H1) */
  touchCopies(): Promise<void>;
  /** 명단 행을 넣거나(새 키) 고치고(같은 키) 구성원을 바꿔 넣는다(옛 구성원을 기본 키 차례로 5,000행 [가정]씩 지우고 5,000행씩 넣는다). 새 사본 판을 돌려준다 */
  putList(row: ListWrite, accountIds: readonly string[]): Promise<number>;
  /** 구성원(5,000행씩)과 명단 행을 지우고 지운 기록(새 사본 판)을 남긴다. 그 판을 돌려준다(리뷰 S1) */
  deleteList(listId: string, listKey: string, now: Date): Promise<number>;
  /** 판매 승인: pending_revision을 공개본으로 옮기고 규모·결제사 칸을 정한다(판매 승인 LCH-080) */
  approve(input: SaleApprovalInput): Promise<SaleState>;
  /** 판매 승인 반려: 사유를 남기고 상태만 바꾼다. pending_revision은 다음 수정·재요청에 남긴다 */
  reject(reason: string, now: Date): Promise<void>;
}

/** 잠금 밖에서 먼저 보는 공연(소속·승인 이력·판매 중지). 잠금 안에서 다시 본다 */
export interface SaleOwnerView {
  approvedBefore: boolean;
  suspended: boolean;
}

export interface SaleStore {
  /** 공연의 판매자(테넌트). 관제 판매 승인은 요청에 테넌트가 없어 이 값으로 잠금 범위를 정한다. 없으면 undefined */
  promoterOf(productionId: string): Promise<string | undefined>;
  /** 그 테넌트의 공연이면 보기, 아니면 undefined(없는 공연과 남의 공연은 같다) */
  owner(productionId: string, tenantId: string): Promise<SaleOwnerView | undefined>;
  /** 잠금 없이 읽는 판매 상태(읽기 전용 REPEATABLE READ 한 번). 없거나 남의 것이면 undefined */
  read(productionId: string, tenantId: string): Promise<SaleState | undefined>;
  /** 그 테넌트의 회차가 속한 공연 ID(없는 회차와 남의 회차는 undefined) */
  eventProduction(eventId: string, tenantId: string): Promise<string | undefined>;
  /** 공연 행을 잠근 트랜잭션에서 fn을 부른다. 없거나 남의 것이면 'not-found'이고 fn을 부르지 않는다. fn이 던지면 되돌린다 */
  withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: SaleTx) => Promise<T>): Promise<T | 'not-found'>;
  /** 사본으로 넘긴 판을 적는다(지금 판 이하이고 앞 값보다 클 때만) */
  markCopied(listId: string, tenantId: string, copySeq: number): Promise<void>;
  /**
   * 올리기 한 번을 센다(공연 행 잠금 안에서 지난 한 시간 [가정]의 올리기 수를 보고 넣는다, 리뷰 S5). 한도를 넘으면 넣지 않고 가장 오래된 올리기가 창에서 빠질 때까지의 시간
   */
  takeUploadSlot(productionId: string, tenantId: string, now: Date, limit: number, windowMs: number): Promise<{ ok: true } | { ok: false; retryAfterMs: number } | 'not-found'>;
  /** 사본 지우기가 끝난 지운 기록을 지운다 */
  dropDone(productionId: string, tenantId: string, listKey: string, copySeq: number): Promise<void>;
}

/** 정비 일이 다룰 명단 하나 */
export interface MaintenanceList {
  id: string;
  productionId: string;
  key: string;
  copySeq: number;
  destroyDueAt: Date;
}

/** 사본 지우기를 다시 할 지운 기록 하나 */
export interface PendingDrop {
  productionId: string;
  listKey: string;
  copySeq: number;
}

/** 정비 일(relay 프로세스의 정비 리더, 모든 테넌트, 소유자 권한 연결)의 저장소 */
export interface SaleMaintenanceStore {
  /** destroy_due_at ≤ now인 명단(오래된 차례, limit개까지) */
  dueForPurge(now: Date, limit: number): Promise<MaintenanceList[]>;
  /**
   * 명단 행을 FOR UPDATE로 잡고 destroy_due_at ≤ now를 다시 본 뒤 구성원을 기본 키 차례로 chunk행씩 지우고 명단 행을 지우며 지운 기록(새 사본 판)을 남긴다(리뷰 S1·S7·C4).
   * 지웠으면 사본 지우기에 넘길 회차 ID와 판, 그 사이 바뀌어 지우지 않았으면 undefined. signal이 끊기면 되돌린다
   */
  purge(list: MaintenanceList, now: Date, chunk: number, signal?: AbortSignal): Promise<{ eventIds: string[]; copySeq: number } | undefined>;
  /** 넘긴 판이 사본 판보다 작은 명단(파기 시각 전, limit개까지) */
  pendingCopies(now: Date, limit: number): Promise<MaintenanceList[]>;
  /** 넘길 명단 수(구성원은 읽지 않는다, 리뷰 C1) */
  countPendingCopies(now: Date): Promise<number>;
  /** 사본에 넘길 데이터(구성원 계정 ID·지금 규칙과 회차로 계산한 회차·수명). 명단이 그 판이 아니면 undefined */
  copyData(list: MaintenanceList): Promise<{ eventIds: string[]; accountIds: string[]; expiresAt: Date } | undefined>;
  markCopied(listId: string, copySeq: number): Promise<void>;
  /** 사본 지우기를 다시 할 지운 기록(오래된 차례, limit개까지)과 그 수 */
  pendingDrops(limit: number): Promise<PendingDrop[]>;
  countPendingDrops(): Promise<number>;
  /** 지운 기록의 공연 회차 모두(사본은 회차마다 키라 넉넉히 지운다) */
  dropEventIds(productionId: string): Promise<string[]>;
  dropDone(drop: PendingDrop): Promise<void>;
  /** 이 시각보다 오래된 올리기 기록을 지운다(지운 수) */
  deleteUploadsBefore(cutoff: Date): Promise<number>;
}

export const SALE_STORE = Symbol('SALE_STORE');
/** 관제 판매 승인용 저장소(모든 테넌트, core DB). 파트너 경로의 SALE_STORE와 나눈다 */
export const OPS_SALE_STORE = Symbol('OPS_SALE_STORE');
