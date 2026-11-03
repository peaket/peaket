// 묶음 게시 컨텍스트의 포트: 대기열 Redis의 묶음 기록, 시드·비콘, 결과 파일(docs/features/queue-admission.md §3 '묶음의 첫 구현').

/** 닫힘 표시 batch_done의 {batchNo} 값 {첫 번호}:{크기}:{세대} */
export interface ClosedBatch {
  first: number;
  size: number;
  gen: number;
}

export interface BatchEntry {
  tokenHash: string;
  seq: number;
}

/** 게시 표시: 게시 시각 pub:{n}, 머클 루트 root:{n}, queue-svc가 결과 키를 잃은 참가자를 보고 쓴 다시 쓰기 표시 repair:{n}(처음 청한 시각) */
export interface PublishedBatch {
  atMs: number;
  root: string | null;
  repairAtMs: number | null;
}

export const BATCH_STORE = Symbol('admission.BatchStore');
export interface BatchStore {
  /** 회차 일정 사본(q:{event:E}:cfg)의 공연 시작 시각. 없으면 null */
  startsAtOf(eventId: string): Promise<number | null>;
  closed(eventId: string, batchNo: number): Promise<ClosedBatch | null>;
  /** 묶음 참가자(사전 검증 토큰 해시, 겹침 없이). 큰 묶음도 회차 샤드를 오래 막지 않게 나눠 읽는다 */
  members(eventId: string, batchNo: number): Promise<string[]>;
  /** 게시 표시. 게시 전이면 null */
  published(eventId: string, batchNo: number): Promise<PublishedBatch | null>;
  /** 사람별 결과 q:batch:{토큰 해시} = {번호}:{세대}(수명 판매 종료). 같은 값을 다시 써도 되므로 잠시 안 되면 그 덩어리를 다시 보낸다 */
  writeResults(entries: readonly BatchEntry[], gen: number, expireAtMs: number): Promise<void>;
  /** 아무도 갖지 않는 번호(잃은 SADD의 자리)를 빠진 번호 비트맵에 켠다 */
  markRemoved(eventId: string, seqs: readonly number[], expireAtMs: number): Promise<void>;
  /** 게시 시각과 머클 루트를 비어 있을 때만 쓴다(두 번째 게시가 게시 시각을 늦춰 분산 창을 다시 닫지 않게) */
  markPublished(eventId: string, batchNo: number, atMs: number, root: string): Promise<void>;
  /**
   * 게시 전 복제 확인(ADR-0181 결정 5, ADR-0182 결정 7): 묶음 표시가 읽은 값(marker)과 같은 노드에서만 한 번 쓰고(wait:{n}) WAIT로 최소 복제본 수가 받았는지 본다.
   * 복제는 순서대로라 그 쓰기가 복제됐으면 묶음 표시까지 복제됐다. 표시가 다르거나(장애 전환 중 다른 노드) 모자라면 false(그 주기는 게시하지 않는다)
   */
  confirmReplicated(eventId: string, batchNo: number, marker: string): Promise<boolean>;
  /** 다시 쓰기 표시를 본 값일 때만 지운다 */
  clearRepair(eventId: string, batchNo: number, repairAtMs: number): Promise<void>;
}

export const SEED_SOURCE = Symbol('admission.SeedSource');
/** 묶음마다 따로 둔 시드(커밋은 오픈 10분 전 공시). 운영은 KMS 봉인(BUILD_ORDER HOT-040) */
export interface SeedSource {
  seed(eventId: string, batchNo: number): Promise<Buffer>;
}

export const BEACON = Symbol('admission.Beacon');
/** 미리 공시한 비콘 라운드의 값. 아직 나오지 않았으면 null(그 라운드를 기다린다, ADR-0050 결정 7). 운영은 drand(HOT-040) */
export interface Beacon {
  value(eventId: string, batchNo: number): Promise<Buffer | null>;
}

export const RESULT_FILES = Symbol('admission.ResultFiles');
/** 결과 파일 batch-results/{토큰 해시 앞 세 자리}.json({해시: 번호}). 운영은 S3·CDN(HOT-050) */
export interface ResultFiles {
  write(eventId: string, batchNo: number, files: ReadonlyMap<string, Record<string, number>>): Promise<void>;
}
