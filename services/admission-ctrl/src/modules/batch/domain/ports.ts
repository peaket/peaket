// 묶음 게시 컨텍스트의 포트: 대기열 Redis의 묶음 기록, 시드·비콘, 결과 파일(docs/features/queue-admission.md §3 '묶음의 첫 구현'). 구간은 동시 도착 묶음(1)과 로비(lobby)다(HOT-040, ADR-0231).
import type { ShuffleGroup } from '@peaket/shuffle';

export type { ShuffleGroup };

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

/** 먼저 공시한 머클 루트(batch_done의 root:{구간}·rootAt:{구간}, ADR-0232 결정 5) */
export interface EarlyRoot {
  root: string;
  atMs: number;
}

export const BATCH_STORE = Symbol('admission.BatchStore');
export interface BatchStore {
  /** 회차 일정 사본(q:{event:E}:cfg). 없으면 null */
  scheduleOf(eventId: string): Promise<BatchSchedule | null>;
  closed(eventId: string, group: ShuffleGroup): Promise<ClosedBatch | null>;
  /** 묶음 참가자(사전 검증 토큰 해시, 겹침 없이). 큰 묶음도 회차 샤드를 오래 막지 않게 나눠 읽는다 */
  members(eventId: string, group: ShuffleGroup): Promise<string[]>;
  /** 게시 표시. 게시 전이면 null */
  published(eventId: string, group: ShuffleGroup): Promise<PublishedBatch | null>;
  /** 사람별 결과 q:batch:{토큰 해시} = {번호}:{세대}(수명 판매 종료). 같은 값을 다시 써도 되므로 잠시 안 되면 그 덩어리를 다시 보낸다 */
  writeResults(group: ShuffleGroup, entries: readonly BatchEntry[], gen: number, expireAtMs: number): Promise<void>;
  /** 아무도 갖지 않는 번호(잃은 SADD의 자리)를 빠진 번호 비트맵에 켠다 */
  markRemoved(eventId: string, seqs: readonly number[], expireAtMs: number): Promise<void>;
  /** 게시 시각과 머클 루트를 비어 있을 때만 쓴다(두 번째 게시가 게시 시각을 늦춰 분산 창을 다시 닫지 않게) */
  markPublished(eventId: string, group: ShuffleGroup, atMs: number, root: string): Promise<void>;
  /** 머클 루트를 비콘 전에 공시한다. 비어 있을 때만 쓰고, 공시 시각은 저장소 시각(Redis TIME)이다. 남아 있는 값(먼저 쓴 값)을 돌려준다(ADR-0232 결정 5) */
  markRoot(eventId: string, group: ShuffleGroup, root: string, expireAtMs: number): Promise<EarlyRoot>;
  /** 먼저 공시한 머클 루트. 없으면 null */
  earlyRootOf(eventId: string, group: ShuffleGroup): Promise<EarlyRoot | null>;
  /**
   * 게시 전 복제 확인(ADR-0181 결정 5, ADR-0182 결정 7): 묶음 표시가 읽은 값(marker)과 같은 노드에서만 한 번 쓰고(wait:{n}) WAIT로 최소 복제본 수가 받았는지 본다.
   * 복제는 순서대로라 그 쓰기가 복제됐으면 묶음 표시까지 복제됐다. 표시가 다르거나(장애 전환 중 다른 노드) 모자라면 false(그 주기는 게시하지 않는다)
   */
  confirmReplicated(eventId: string, group: ShuffleGroup, marker: string): Promise<boolean>;
  /** 다시 쓰기 표시를 본 값일 때만 지운다 */
  clearRepair(eventId: string, group: ShuffleGroup, repairAtMs: number): Promise<void>;
  /** q:{event:E}:verify에서 값이 VERIFYING(§7)이거나 ORPHAN(목록 고정 뒤 되돌리기가 남긴 주인 없는 자리)인 해시들. 게시 때 그 번호를 빠진 번호로 돌린다 */
  toRemoveAmong(eventId: string, hashes: readonly string[]): Promise<string[]>;
}

/** 일정에서 게시가 쓰는 값 */
export interface BatchSchedule {
  startsAtMs: number;
  opensAtMs: number;
  batchWindowMs?: number;
}

/** 공시 기록(q:{event:E}:shuffle, ADR-0231 결정 6). 멈춤 표시는 이유와 시각을 함께 둔다(RB-35 CLI만 지운다) */
export type BeaconStopReason = 'beacon' | 'stale_round' | 'late_commit' | 'no_commit' | 'late_root' | 'members_changed' | 'unknown';
export interface ShuffleRecord {
  commit: string;
  round: number;
  sealed: string;
  atMs: number;
  stopped?: { reason: BeaconStopReason; atMs: number };
  /** 게시 때 받은 비콘(16진, ADR-0232 결정 6) */
  beacon?: string;
  signature?: string;
  /** 공개한 시드(16진)와 공개 시각(ADR-0232 결정 7) */
  seed?: string;
  seedAtMs?: number;
}
export const SHUFFLE_RECORDS = Symbol('admission.ShuffleRecords');
export interface ShuffleRecords {
  read(eventId: string, group: ShuffleGroup): Promise<ShuffleRecord | null>;
  /** 멈춤을 비어 있을 때만 쓴다(공시 기록이 없어도 쓴다). 수명은 회차 키와 같게 늦은 쪽으로만 늘린다. 이 호출이 쓴 때만 true다(SEV1을 한 번만 내려고) */
  stop(eventId: string, group: ShuffleGroup, atMs: number, reason: BeaconStopReason, expireAtMs: number): Promise<boolean>;
  /** 게시 때 받은 비콘 값과 서명을 비어 있을 때만 쓴다(ADR-0232 결정 6) */
  recordBeacon(eventId: string, group: ShuffleGroup, value: string, signature: string, expireAtMs: number): Promise<void>;
  /** 공개한 시드를 비어 있을 때만 쓴다(ADR-0232 결정 7) */
  reveal(eventId: string, group: ShuffleGroup, seed: string, atMs: number, expireAtMs: number): Promise<void>;
}

export const SEED_SOURCE = Symbol('admission.SeedSource');
/** 묶음마다 따로 둔 시드(커밋은 오픈 10분 전 공시). 운영은 KMS 봉인(BUILD_ORDER HOT-041) */
export interface SeedSource {
  seed(eventId: string, group: ShuffleGroup): Promise<Buffer>;
}

export const BEACON = Symbol('admission.Beacon');
/** 비콘 라운드의 값과 서명(16진). 공시 기록과 검증 화면에 그대로 낸다 */
export interface BeaconRound {
  value: Buffer;
  signature: string;
}
/** 미리 공시한 비콘 라운드. 아직 나오지 않았으면 null(그 라운드를 기다린다, ADR-0050 결정 7). 운영은 drand(HOT-041) */
export interface Beacon {
  round(eventId: string, group: ShuffleGroup): Promise<BeaconRound | null>;
}

export const RESULT_FILES = Symbol('admission.ResultFiles');
/** 결과 파일 {shuffle-results|batch-results}/{토큰 해시 앞 세 자리}.json({해시: 번호}). 운영은 객체 저장소(ObjectStoreResultFiles, ADR-0232 결정 1) */
export interface ResultFiles {
  write(eventId: string, group: ShuffleGroup, files: ReadonlyMap<string, Record<string, number>>): Promise<void>;
}

/** 객체 저장소 쓰기(실제 S3 어댑터는 BUILD_ORDER HOT-012). 실패하면 던진다. 구현은 호출마다 짧은 마감(5초 [가정])을 둬야 한다. 마감이 없어 PUT이 멈추면 그 구간의 게시가 영영 끝나지 않는다 */
export interface ResultObjectStore {
  put(i: { key: string; body: string; contentType: string; cacheControl: string }): Promise<void>;
}
