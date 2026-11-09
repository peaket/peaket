// 대기 상태 파일 컨텍스트의 포트: 회차 슬롯의 값 읽기, 회차 일정 사본, 설정.
import type { PlatformNotice, StateSnapshot } from './state.js';

export const STATE_SNAPSHOTS = Symbol('state.StateSnapshots');
/** 회차 슬롯 Lua 하나로 파일에 쓸 값을 읽는다. 대기열 Redis가 잠시 안 되면 던진다 */
export interface StateSnapshots {
  read(eventId: string): Promise<StateSnapshot>;
  /** 전체 범위 공지 q:{event:PLATFORM}:notice(일시정지·판매 중지·공지 배너, ADR-0214). 대기열 Redis가 잠시 안 되면 던진다 */
  readPlatform(): Promise<PlatformNotice>;
}

export const STATE_MIRROR_STORE = Symbol('state.MirrorStore');
export const STATE_MIRROR_LEASE = Symbol('state.MirrorLease');
export const STATE_MIRROR_SIGNALS = Symbol('state.MirrorSignals');
/** S3 대체 원본 사본 쓰기(실제 어댑터는 BUILD_ORDER HOT-012). 실패하면 던진다 */
export interface StateMirrorStore {
  put(i: { key: string; body: string; contentType: string; cacheControl: string; expiresAtMs?: number }): Promise<void>;
}
/** 이번 초 경계에 사본을 쓸 파드 하나를 고른다(SET q:{event:E}:mirror NX PX 900 [가정]). 대기열 Redis가 잠시 안 되면 던진다 */
export interface StateMirrorLease {
  claim(eventId: string, boundaryMs: number): Promise<boolean>;
}
export interface StateMirrorSignals {
  failed(): void;
}

export const STATE_SCHEDULES = Symbol('state.EventSchedules');

export const SHUFFLE_PROOF_SOURCE = Symbol('state.ShuffleProofSource');
/** 셔플 공시 기록과 게시 표시를 칸 원문으로 읽는다(ADR-0232 결정 8) */
export interface ShuffleProofSource {
  read(eventId: string): Promise<import('./proof.js').ProofFields>;
}

export type ResultFileKind = 'shuffle-results' | 'batch-results';
export const RESULT_FILE_READER = Symbol('state.ResultFileReader');
/** 결과 파일 읽기(local·ci·demo). 없으면 null이고 404가 된다 */
export interface ResultFileReader {
  read(eventId: string, kind: ResultFileKind, prefix: string): Promise<string | null>;
}

export const STATE_OPTIONS = Symbol('state.Options');
export interface StateOptions {
  /** 대기열 파일의 교차 출처 허용(소비자 웹 하나, ADR-0065 결정 7) */
  webOrigin: string;
  /** 매초 경계에 켠 회차의 파일을 다시 만든다(시험은 끄고 tick을 직접 부른다) */
  autoTick: boolean;
}
export const DEFAULT_WEB_ORIGIN = 'https://www.peaket.example';
