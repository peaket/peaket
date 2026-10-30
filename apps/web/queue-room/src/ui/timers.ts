// 초 단위 시계와 낭독(CMP-014 Countdown, CMP-015·016 낭독 규칙).
// requestAnimationFrame을 쓰지 않고 다음 초 경계까지 setTimeout으로 기다린다. 깰 때마다 벽시계로 남은 시간을 다시 계산하고,
// 화면이 다시 보이면 바로 맞춘다(d2 CMP-014, docs/frontend.md §4.8). 시계 보정(§3.3)은 데이터 연결 단계에서 붙인다.

/** 마감 시각(ms)까지 남은 초를 매초 알린다. 0이 되면 onDone. 정리 함수를 돌려준다 */
export function countdown(deadlineMs: number, onTick: (remainingSec: number) => void, onDone?: () => void): () => void {
  let timer = 0;
  let done = false;
  const tick = (): void => {
    const remainingMs = deadlineMs - Date.now();
    const sec = Math.max(0, Math.ceil(remainingMs / 1000));
    onTick(sec);
    if (sec <= 0) {
      if (!done) {
        done = true;
        onDone?.();
      }
      return;
    }
    // 다음 초 경계(남은 ms가 1000의 배수가 되는 때)까지 기다린다
    const wait = remainingMs % 1000 || 1000;
    timer = window.setTimeout(tick, wait + 5);
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && !done) {
      window.clearTimeout(timer);
      tick();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  tick();
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** 이정표형 낭독: 남은 5분·1분·10초에 한 번씩만 live 영역에 문장을 넣는다(d1 §5, 기술 검토 낮음-102) */
export function milestoneAnnouncer(region: HTMLElement, label: string): (remainingSec: number) => void {
  const said = new Set<number>();
  const marks: [number, string][] = [
    [300, '5분'],
    [60, '1분'],
    [10, '10초'],
  ];
  return (sec) => {
    for (const [at, text] of marks) {
      if (sec === at && !said.has(at)) {
        said.add(at);
        region.textContent = `${label} ${text} 남았습니다`;
      }
    }
  };
}

/** 1분에 한 번 같은 문장을 live 영역에 다시 넣어 낭독한다(대기열, ADR-0063). 숫자 자체에는 live를 두지 않는다 */
export function announceEveryMinute(region: HTMLElement, sentence: () => string): () => void {
  const id = window.setInterval(() => {
    region.textContent = '';
    window.setTimeout(() => {
      region.textContent = sentence();
    }, 100);
  }, 60_000);
  return () => window.clearInterval(id);
}
