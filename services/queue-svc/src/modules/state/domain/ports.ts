// 대기 상태 파일 컨텍스트의 포트: 회차 슬롯의 값 읽기, 회차 일정 사본, 설정.
import type { StateSnapshot } from './state.js';

export const STATE_SNAPSHOTS = Symbol('state.StateSnapshots');
/** 회차 슬롯 Lua 하나로 파일에 쓸 값을 읽는다. 대기열 Redis가 잠시 안 되면 던진다 */
export interface StateSnapshots {
  read(eventId: string): Promise<StateSnapshot>;
}

export const STATE_SCHEDULES = Symbol('state.EventSchedules');

export const STATE_OPTIONS = Symbol('state.Options');
export interface StateOptions {
  /** 대기열 파일의 교차 출처 허용(소비자 웹 하나, ADR-0065 결정 7) */
  webOrigin: string;
  /** 매초 경계에 켠 회차의 파일을 다시 만든다(시험은 끄고 tick을 직접 부른다) */
  autoTick: boolean;
}
export const DEFAULT_WEB_ORIGIN = 'https://www.peaket.example';
