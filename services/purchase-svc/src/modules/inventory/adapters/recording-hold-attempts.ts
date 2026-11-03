// 홀드 시도 기록의 메모리 구현(시험이 남은 시도를 읽는다). Kafka telemetry.purchase로 HoldAttempt(Avro)를 보내는 어댑터는 BAS-030이다.
import type { HoldAttemptRecord, HoldAttempts } from '../domain/ports.js';

/** 받은 시도를 받은 차례대로 쌓는다 */
export class RecordingHoldAttempts implements HoldAttempts {
  readonly records: HoldAttemptRecord[] = [];

  /** records 끝에 사본을 더한다(던지지 않는다) */
  record(a: HoldAttemptRecord): void {
    this.records.push({ ...a, seatIds: [...a.seatIds] });
  }
}

/** 보낼 곳이 아직 없는 운영 조립(PRF-130 ①의 main.ts)용: 받은 시도를 버린다 */
export const discardHoldAttempts: HoldAttempts = {
  record: () => undefined,
};
