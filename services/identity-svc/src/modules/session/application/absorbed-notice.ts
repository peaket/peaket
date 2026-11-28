// F-06-1 POL-034: 흡수 계정 완료 통지를 한 번 보내고, 실패는 지표로만 남긴다.
// identity는 주소를 저장하지 않는다. 병합 확정 트랜잭션 안에서 이 함수를 부르며, 실패해도 던지지 않아 병합을 막지 않는다.
export type MergeNoticeFailure = 'unavailable' | 'deadline' | 'rejected';

export interface AbsorbedNoticeInput {
  mergeId: string;
  absorbedAccountId: string;
  absorbedEmail: string;
}

export interface AbsorbedNoticeDeps {
  send(input: AbsorbedNoticeInput): Promise<boolean>;
  failed(reason: MergeNoticeFailure): void;
}

/** 보내기 한 번. 실패는 failed('unavailable')만 부르고 false를 돌려준다(호출한 트랜잭션은 계속) */
export async function sendAbsorbedNoticeOnce(deps: AbsorbedNoticeDeps, input: AbsorbedNoticeInput): Promise<boolean> {
  try {
    return await deps.send(input);
  } catch {
    deps.failed('unavailable');
    return false;
  }
}
