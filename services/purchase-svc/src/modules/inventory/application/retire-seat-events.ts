// 회차 목록 빼기 정비 일 retire-seat-events(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '좌석 묶기와 실패 해제의 첫 구현' 회차 목록에서 빼기,
// '릴레이 프로세스와 조립의 첫 구현' 정비 일). 릴레이 프로세스의 리더 하나가 platform MaintenanceRunner로 하루 한 번 돌린다.
// s:ctl:events의 회차마다 좌석맵 판의 판매 종료로 retireEvent(PRF-142)를 부르고 결과를 센다. 조건(판매 종료 + 1시간, Stream·확인받지 못한 항목·만료 인덱스 0)은 retireEvent가 본다.
// 구현에서 정한 것: 로그 줄에는 kind 'retire-seat-events'를 달고(판이 없는 회차는 reason 'no_seat_map'), 로거가 던져도 결과를 바꾸지 않는다.
// 끝에 던지는 오류 글에는 실패 수만 싣는다(회차 ID·원래 오류 글은 회차마다의 경고 줄에 이름만 남는다. 정비 실행기가 이 글을 경고 줄에 싣는다).
import type { MaintenanceTask } from '@peaket/platform';
import type { SeatEventRetire, SeatExpiries, SeatMap } from '../domain/ports.js';

/** 정비 일 이름(maintenance_task_* 지표의 task 이름표) */
export const RETIRE_SEAT_EVENTS_TASK = 'retire-seat-events';

export interface RetireSeatEventsDeps {
  /** 회차 목록 읽기와 빼기(운영은 RedisSeatStore. retireEvent의 '지금'은 그 저장소의 주입 Clock = 정비 잡 프로세스의 시계) */
  store: Pick<SeatExpiries, 'saleEvents'> & SeatEventRetire;
  /** 회차의 판(판매 종료 saleEndsAtMs) */
  seatMap: Pick<SeatMap, 'config'>;
  /** 판이 없는 회차·회차 하나의 오류는 warn 한 줄(회차 ID·오류 이름만), 끝의 건수는 info 한 줄(있을 때만) */
  logger: { warn(obj: object, msg: string): void; info?(obj: object, msg: string): void };
}

/** 한 번 돈 결과(회차 수). retired·tooEarly·streamPending·expiryPending·notListed는 RetireResult마다 하나다 */
export interface RetireSeatEventsReport {
  retired: number;
  tooEarly: number;
  streamPending: number;
  expiryPending: number;
  notListed: number;
  /** 좌석맵 판이 없어(config가 undefined) retireEvent를 부르지 않은 회차 */
  skipped: number;
  /** config나 retireEvent가 던진 회차 */
  failed: number;
}

/** run이 보고를 돌려주는 MaintenanceTask(시험이 형 바꾸기 없이 보고를 읽게) */
export type RetireSeatEventsTask = MaintenanceTask & { run(signal?: AbortSignal): Promise<RetireSeatEventsReport> };

/**
 * 정비 일 하나(name RETIRE_SEAT_EVENTS_TASK, when 'daily': 시간 무관 하루 한 번 성공할 때까지).
 * run(signal):
 * 1. store.saleEvents()(던지면 그대로 던진다: 정비 실행기가 실패로 세고 다음 깨어남에 다시 한다)
 * 2. 회차마다 받은 차례로 하나씩(signal이 끊기면 남은 회차를 보지 않고 그때까지의 보고를 돌려준다):
 *    seatMap.config(eventId)가 undefined면 skipped를 세고 warn 한 줄 → 아니면 store.retireEvent({ eventId, saleEndMs: config.saleEndsAtMs })의 결과를 센다.
 *    config나 retireEvent가 던지면 warn 한 줄(회차 ID·오류 이름만)을 남기고 failed를 센 뒤 다음 회차로 간다
 * 3. 끝에 info 한 줄(건수, logger.info가 있을 때만). failed가 1 이상이면 던진다(Error, 글에 실패 수만): 정비 실행기가 실패로 세고 다음 깨어남에 다시 한다
 *    (이미 뺀 회차를 다시 불러도 NOT_LISTED라 안전하다). 멈춤 신호로 일찍 끝난 run도 같은 규칙이다
 */
export function retireSeatEventsTask(deps: RetireSeatEventsDeps): RetireSeatEventsTask {
  const { store, seatMap, logger } = deps;
  /** 로그 한 줄(로거가 던져도 정비 일의 결과를 바꾸지 않는다) */
  const log = (level: 'warn' | 'info', obj: object, msg: string) => {
    try {
      if (level === 'warn') logger.warn(obj, msg);
      else logger.info?.(obj, msg);
    } catch {
      // 로그 실패는 정비 일을 막지 않는다
    }
  };
  return {
    name: RETIRE_SEAT_EVENTS_TASK,
    when: 'daily',
    async run(signal?: AbortSignal): Promise<RetireSeatEventsReport> {
      const report: RetireSeatEventsReport = { retired: 0, tooEarly: 0, streamPending: 0, expiryPending: 0, notListed: 0, skipped: 0, failed: 0 };
      const events = await store.saleEvents();
      for (const eventId of events) {
        if (signal?.aborted) break;
        try {
          const config = await seatMap.config(eventId);
          if (config === undefined) {
            report.skipped += 1;
            log('warn', { kind: RETIRE_SEAT_EVENTS_TASK, eventId, reason: 'no_seat_map' }, '회차 목록 빼기: 좌석맵 판이 없어 판매 종료를 몰라 넘긴다');
            continue;
          }
          const result = await store.retireEvent({ eventId, saleEndMs: config.saleEndsAtMs });
          switch (result) {
            case 'RETIRED':
              report.retired += 1;
              break;
            case 'TOO_EARLY':
              report.tooEarly += 1;
              break;
            case 'STREAM_PENDING':
              report.streamPending += 1;
              break;
            case 'EXPIRY_PENDING':
              report.expiryPending += 1;
              break;
            case 'NOT_LISTED':
              report.notListed += 1;
              break;
          }
        } catch (err) {
          // 오류 글에는 주소·경로가 실릴 수 있어 이름만 남긴다
          report.failed += 1;
          log('warn', { kind: RETIRE_SEAT_EVENTS_TASK, eventId, err: err instanceof Error ? err.name : typeof err }, '회차 목록 빼기: 회차 하나를 보지 못했다(다음 깨어남에 다시 한다)');
        }
      }
      log('info', { kind: RETIRE_SEAT_EVENTS_TASK, ...report }, '회차 목록 빼기 건수');
      // 정비 실행기가 실패로 세고 다음 깨어남에 다시 한다(이미 뺀 회차는 NOT_LISTED라 다시 불러도 안전하다). 글에는 실패 수만 싣는다(실행기가 경고 줄에 싣는다)
      if (report.failed > 0) throw new Error(`회차 목록 빼기에서 회차 ${report.failed}개를 보지 못했다`);
      return report;
    },
  };
}
