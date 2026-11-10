// payment-svc 종료 차례(BUILD_ORDER PRF-180·HOT-150 코드 리뷰). main.ts의 SIGTERM이 부른다.
// 앞 단계가 실패해도 다음 단계를 한다: 멈추기를 모두 기다린 뒤(돌던 쓰기가 닫힌 풀을 만나지 않게) 멈추기가 넘긴 일을 받는 쪽을 멈추고(drain), 서비스를 닫고, 그 뒤에 연결을 닫는다.

export interface ShutdownSteps {
  /** 새 호출을 받지 않고 돌던 일을 멈춘다 */
  stop(): Promise<unknown>[];
  /** stop()이 모두 끝난 뒤에 멈춘다: 실행기가 마무리하며 넘기는 일을 받는 쪽(BUILD_ORDER PRF-203 코드 리뷰 F5) */
  drain?(): Promise<unknown>[];
  closeService(): Promise<void>;
  closeConnections(): (Promise<unknown> | undefined)[];
  /** 단계의 실패마다 부른다 */
  onError(err: unknown): void;
}

/** 던지지 않는다(실패는 onError로 알린다) */
export async function shutdownInOrder(s: ShutdownSteps): Promise<void> {
  const report = (results: PromiseSettledResult<unknown>[]): void => {
    for (const r of results) if (r.status === 'rejected') s.onError(r.reason);
  };
  report(await Promise.allSettled(s.stop()));
  if (s.drain) report(await Promise.allSettled(s.drain()));
  report(await Promise.allSettled([s.closeService()]));
  report(await Promise.allSettled(s.closeConnections()));
}
