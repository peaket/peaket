// 종료 차례(docs/devops.md §6.4 ③, BUILD_ORDER BAS-080). payment-svc에 있던 것(PRF-180·HOT-150 코드 리뷰)을 서비스 뼈대로 옮겼다.
// 앞 단계가 실패해도 다음 단계를 한다: 멈추기(gRPC 마감·돌던 일)를 모두 기다린 뒤(돌던 쓰기가 닫힌 풀을 만나지 않게) 멈추기가 넘긴 일을 받는 쪽을 멈추고(drain),
// 서비스를 닫고(app.close()가 모듈 종료 훅을 부른다), 그 뒤에 연결을 닫는다. NestJS enableShutdownHooks()는 켜지 않는다(같은 신호에 앱이 먼저 닫힌다).
// 준비 상태는 SIGTERM을 받는 즉시 서비스 뼈대(createService)가 내린다.

export interface ShutdownSteps {
  /** 새 호출을 받지 않고 돌던 일을 멈춘다(gRPC 서버 close가 여기 든다) */
  stop(): Promise<unknown>[];
  /** stop()이 모두 끝난 뒤에 멈춘다: 실행기가 마무리하며 넘기는 일을 받는 쪽(BUILD_ORDER PRF-203 코드 리뷰 F5) */
  drain?(): Promise<unknown>[];
  closeService(): Promise<void>;
  closeConnections(): (Promise<unknown> | undefined)[];
  /** 단계의 실패마다 부른다 */
  onError(err: unknown): void;
}

const running = new WeakMap<ShutdownSteps, Promise<void>>();

/** 던지지 않는다(실패는 onError로 알린다). 같은 steps로 두 번 부르면 한 번만 하고 같은 약속을 돌려준다 */
export function shutdownInOrder(s: ShutdownSteps): Promise<void> {
  let p = running.get(s);
  if (!p) {
    p = inOrder(s);
    running.set(s, p);
  }
  return p;
}

async function inOrder(s: ShutdownSteps): Promise<void> {
  const report = (results: PromiseSettledResult<unknown>[]): void => {
    for (const r of results) if (r.status === 'rejected') s.onError(r.reason);
  };
  // 단계를 만드는 함수가 던져도(동기 실패) 다음 단계를 한다
  const run = async (make: () => (Promise<unknown> | undefined)[]): Promise<void> => {
    let steps: (Promise<unknown> | undefined)[];
    try {
      steps = make();
    } catch (err) {
      s.onError(err);
      return;
    }
    report(await Promise.allSettled(steps));
  };
  await run(() => s.stop());
  if (s.drain) await run(() => s.drain!());
  await run(() => [s.closeService()]);
  await run(() => s.closeConnections());
}

/**
 * SIGTERM에 fn을 한 번만 부른다(두 번째 SIGTERM부터는 무시한다. 처리기를 남겨 두어 기본 동작인 즉시 끝내기로 넘어가지 않는다).
 * fn이 거부되면 종료 코드 1을 둔다. 준비 상태 내림은 서비스 뼈대가 이 처리기보다 먼저 한다(createService의 sigtermReadiness)
 */
export function onSigterm(fn: () => Promise<void>): void {
  let started = false;
  process.on('SIGTERM', () => {
    if (started) return;
    started = true;
    void fn().catch(() => {
      process.exitCode = 1;
    });
  });
}
