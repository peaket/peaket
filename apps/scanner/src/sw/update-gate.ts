// 새 앱 판 적용 시점과 최소 지원 판(offline-gate §6.2 '앱 갱신', devops §6.6).
// 새 서비스 워커 판은 근무 준비 때만 적용하고, 입장 중에는 미룬다(C1-15).
// 이 파일은 Node 시험이 그대로 읽으므로 브라우저 전역을 쓰지 않는다.
export type ScannerPhase = 'prep' | 'entry';

export type AppVersionGate = { allowed: true } | { allowed: false; reason: 'UPDATE_REQUIRED'; required: string };

/** SemVer의 숫자 세 자리만 비교한다. 읽을 수 없으면 undefined(현장을 세우지 않는다) */
export function compareSemver(a: string, b: string): number | undefined {
  const parse = (v: string): [number, number, number] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
    if (!m) return undefined;
    const n = [Number(m[1]), Number(m[2]), Number(m[3])];
    return n.every((x) => Number.isSafeInteger(x)) ? (n as [number, number, number]) : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

/** 근무 준비 응답의 minAppVersion과 이 앱 판을 견준다. 최소 판이 없거나 읽을 수 없으면 막지 않는다 */
export function appVersionGate(i: { appVersion: string; minAppVersion?: string }): AppVersionGate {
  const min = i.minAppVersion?.trim();
  if (!min) return { allowed: true };
  const cmp = compareSemver(i.appVersion, min);
  if (cmp === undefined) return { allowed: true };
  if (cmp >= 0) return { allowed: true };
  return { allowed: false, reason: 'UPDATE_REQUIRED', required: min };
}

/** 대기 중인 새 판을 지금 적용해도 되는가. 근무 준비 + 스캔 없음일 때만이다 */
export function shouldApplyUpdate(i: { phase: ScannerPhase; waiting: boolean; activeScans?: number }): boolean {
  if (i.phase !== 'prep') return false;
  if (!i.waiting) return false;
  return (i.activeScans ?? 0) === 0;
}

/** 새 판을 적용한 뒤에는 목록을 다시 받는다(목록 형식이 바뀌었을 수 있다) */
export function packageRefetchAfterUpdate(i: { applied: boolean }): boolean {
  return i.applied;
}
