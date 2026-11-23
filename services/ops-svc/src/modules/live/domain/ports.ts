// 관제 SSE 모듈의 포트(ADR-0360). DB 조립은 알림 표·접속자 표(마이그레이션 0028), 메모리 조립은 명령 저장소를 훑는 대역이다.
import type { PushEventRow } from './live.js';
import type { WidgetKey, WidgetValue } from './widgets.js';

/** 알림 표 ops_push_event 읽기 */
export interface PushEventSource {
  /** seq 뒤의 행을 seq 차례로 limit개까지 */
  after(seq: number, limit: number): Promise<readonly PushEventRow[]>;
  /**
   * seq 뒤의 행과 seqs에 든 행(건너뛴 빈 번호 다시 보기)을 한 번에(한 스냅숏) seq 차례로 limit개까지.
   * 없으면 허브가 after로 가장 작은 번호부터 훑는다(작은 대역용)
   */
  afterOrAt?(seq: number, seqs: readonly number[], limit: number): Promise<readonly PushEventRow[]>;
  /** 시퀀스의 마지막 값(쓴 적 없으면 0). 아직 커밋 전인 번호를 포함할 수 있다 */
  latest(): Promise<number>;
  /**
   * 지금 보이는(커밋된) 행 가운데 가장 큰 seq(없으면 0). 경보 목록 REST의 seq다(F-03-3): 그 뒤에 커밋되는 행만 화면이 목록 위에 다시 얹는다.
   * 없으면 latest를 쓴다(메모리 대역)
   */
  committedMax?(): Promise<number>;
  /** 창(windowMs) 안 행 가운데 가장 작은 seq(없으면 undefined) */
  oldestWithin(windowMs: number): Promise<number | undefined>;
  /** 창 밖 행을 지운다. 지운 수 */
  deleteOlderThan(windowMs: number): Promise<number>;
}

/** 접속 중 운영자 한 명(asyncapi OpsPresence operators의 한 항목) */
export interface PresenceEntry {
  readonly accountRef: string;
  readonly role: string;
  readonly screen: string;
}

/** 접속자 표 ops_presence */
export interface PresenceStore {
  /** (계정, 회차) 행을 지금 시각으로 고쳐 쓴다 */
  touch(entry: PresenceEntry & { readonly eventId: string; readonly nowMs: number }): Promise<void>;
  /** 회차별로 창 안의 행(계정 차례) */
  activeByEvent(eventIds: readonly string[], windowMs: number, nowMs: number): Promise<ReadonlyMap<string, readonly PresenceEntry[]>>;
  /** 창 밖 행을 지운다. 지운 수 */
  deleteOlderThan(windowMs: number, nowMs: number): Promise<number>;
}

/** 위젯 값을 읽는 범위. range가 있으면 그래프 점(series)도 싣는다(위젯 조회 REST) */
export interface WidgetReadQuery {
  readonly eventId: string | null;
  readonly nowMs: number;
  readonly range?: { readonly fromMs: number; readonly toMs: number };
}

/** 원천을 읽지 못했다(값 대신 error 'source-unavailable'로 낸다) */
export class WidgetSourceUnavailable extends Error {
  override readonly name = 'WidgetSourceUnavailable';
}

/**
 * 위젯 값 원천 포트(ADR-0360 결정 9, 갈래 1 OPS-160 실시간 표가 같은 포트로 붙는다).
 * - keys: 이 원천이 맡는 위젯 키. 두 원천이 같은 키를 맡으면 조립이 멈춘다
 * - read: 한 키의 지금 값(전체 값). 원천 실패는 WidgetSourceUnavailable을 던진다(다른 오류도 같게 본다). 돌려준 값의 widgetKey는 요청한 키다
 */
export interface WidgetSource {
  readonly keys: readonly WidgetKey[];
  read(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue>;
}

/** 대기열 Redis 자동 제어 상태 읽기 포트(F-03-3, 시험이 바꿔 끼운다). 읽기만 한다 */
export interface ControlReader {
  /** 진행 중 회차 목록(점수 = 키 수명, 지금보다 큰 것) */
  activeEvents(nowMs: number): Promise<string[]>;
  /** 해시 하나. 키가 없으면 undefined */
  hash(key: string): Promise<Record<string, string> | undefined>;
  /** 연결을 닫는다(모듈이 내려갈 때) */
  close?(): Promise<void>;
}
