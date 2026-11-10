// 저장소 호출의 클라이언트 쪽 시간 한도(BUILD_ORDER PRF-203 코드 리뷰 F4, docs/features/payment.md §2 '걸린 연결').
// DB 문장 한도는 연결이 살아 있을 때만 듣는다. 응답이 끊긴 연결 하나가 부르는 쪽(1초 맞추기·캐시·종료)을 멈추지 않게, 한도를 넘으면 기다리지 않고 실패로 본다.

/** 클라이언트 시간 한도를 넘겼다(안전한 오류 코드 CLIENT_TIMEOUT) */
export class ClientTimeoutError extends Error {
  readonly code = 'CLIENT_TIMEOUT' as const;
  constructor() {
    super('저장소 호출이 클라이언트 시간 한도를 넘겼다');
    this.name = 'ClientTimeoutError';
  }
}

/** work가 limitMs 안에 끝나지 않으면 ClientTimeoutError로 실패한다. 늦게 끝난 호출의 결과와 오류는 버린다 */
export async function withClientTimeout<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new ClientTimeoutError()), limitMs);
    handle.unref();
  });
  // 한도 뒤에 실패한 호출이 처리되지 않은 거절로 남지 않게 한다
  work.catch(() => undefined);
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(handle);
  }
}
