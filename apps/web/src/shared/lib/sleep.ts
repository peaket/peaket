// 끊을 수 있는 기다림(본인확인 창 흐름의 닫힘 확인 간격·늦은 메시지 10분, docs/features/identity.md §5 '부르는 화면', BOT-010이 넘긴 것).
// 신호가 끊기면 타이머를 지우고 바로 끝난다(거부하지 않는다: 부르는 쪽은 끝난 뒤 멈췄는지를 스스로 본다).

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(handle);
      resolve();
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
