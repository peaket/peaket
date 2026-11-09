// 취소 신호 묶기(docs/frontend.md §1.5 'AbortSignal.any', 추천 적용 2026-10-28, 기술 검토 중간-095).
// AbortSignal.any는 Chrome 116·Firefox 124·Safari 17.4부터라 지원 범위 안의 iOS·iPadOS 16.4~17.3에는 없다. 그때는 AbortController 하나에
// 신호들의 abort 사건을 잇고, 먼저 끊긴 신호의 reason을 그대로 넘긴다. 이미 끊긴 신호가 있으면 바로 끊고, 끝나면 듣기를 지운다.

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals]);
  const controller = new AbortController();
  const done = signals.find((s) => s.aborted);
  if (done) {
    controller.abort(done.reason);
    return controller.signal;
  }
  const listeners: Array<[AbortSignal, () => void]> = [];
  const cleanup = () => {
    for (const [s, l] of listeners) s.removeEventListener('abort', l);
  };
  for (const s of signals) {
    const onAbort = () => {
      cleanup();
      controller.abort(s.reason);
    };
    listeners.push([s, onAbort]);
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
