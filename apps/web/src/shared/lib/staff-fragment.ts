// 현장 스태프 화면 주소의 비밀 조각(초대 #token=, 스캐너 승인 #code=)을 다루는 규칙(d5 §5.26·§5.27 끝 문단, docs/frontend.md §3.12 `peaket.staff.fragment`,
// ADR-0065 결정 10, BUILD_ORDER F-05-7, ADR-0362).
// ① 화면이 열리자마자 조각을 읽어 이 탭의 세션 저장소에 `{kind, value, at}`로 옮기고 ② 주소창에서 조각을 지운다(history.replaceState, 주소·Referer·기록에 남지 않게).
// ③ 화면은 자기 kind만 꺼내고 남긴 지 10분 [가정]이 지난 값은 버린다 ④ 조회가 성공하면 지운다. 로그인하러 갈 때 next에는 경로만 넣는다(조각·쿼리를 싣지 않는다).
// 로그아웃 정리 루틴에서 이 키를 지우는 일은 GAT-040(F-05-1) 몫이다(계획 F-05-7 §1 '넘기는 것'). 상대 경로만 써서 node 시험이 바로 읽는다.

export const STAFF_FRAGMENT_KEY = 'peaket.staff.fragment';
/** 탭 저장소 값을 믿는 시간 10분 [가정](docs/frontend.md §3.12). 남긴 지 정확히 10분까지는 쓰고 그 뒤는 버린다 */
export const STAFF_FRAGMENT_TTL_MS = 10 * 60_000;

/** invite 초대 수락(SCR-050, #token=) · approve 스캐너 승인(SCR-051, #code=) */
export type StaffFragmentKind = 'invite' | 'approve';
const PARAM: Record<StaffFragmentKind, string> = { invite: 'token', approve: 'code' };

export interface StaffFragmentStorage {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

/** 주소의 조각(`#token=…`)에서 그 화면의 값. 없거나 비었으면 null */
export function fragmentValue(hash: string, kind: StaffFragmentKind): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return null;
  let v: string | null;
  try {
    v = new URLSearchParams(raw).get(PARAM[kind]);
  } catch {
    return null;
  }
  return v && v.length <= 1024 ? v : null;
}

/**
 * 화면이 열릴 때 한 번: 조각에 값이 있으면 탭 저장소에 옮기고, 조각이 있으면(값이 틀려도) 주소창에서 지운다.
 * 지운 주소는 경로와 쿼리만 남긴다(replaceState라 뒤로 가기 기록에도 조각이 남지 않는다)
 */
export function captureStaffFragment(o: {
  kind: StaffFragmentKind;
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  storage: StaffFragmentStorage;
  now: number;
}): void {
  const { hash, pathname, search } = o.location;
  if (hash === '' || hash === '#') {
    if (hash === '#') o.history.replaceState(null, '', `${pathname}${search}`);
    return;
  }
  const value = fragmentValue(hash, o.kind);
  if (value !== null) o.storage.set(STAFF_FRAGMENT_KEY, JSON.stringify({ kind: o.kind, value, at: o.now }));
  o.history.replaceState(null, '', `${pathname}${search}`);
}

/**
 * 탭 저장소에서 그 화면(kind)의 값을 꺼낸다. 다른 화면의 값이면 건드리지 않고 null이다.
 * 남긴 지 10분이 지났거나(정각까지는 쓴다), 남긴 시각이 지금보다 뒤거나, 모양이 틀리면 지우고 null이다. 꺼내도 지우지 않는다(조회 성공 뒤 clearStaffFragment)
 */
export function takeStaffFragment(storage: StaffFragmentStorage, kind: StaffFragmentKind, now: number): string | null {
  const v = storage.get(STAFF_FRAGMENT_KEY);
  if (v === null) return null;
  let p: { kind?: unknown; value?: unknown; at?: unknown };
  try {
    p = JSON.parse(v) as typeof p;
  } catch {
    storage.remove(STAFF_FRAGMENT_KEY);
    return null;
  }
  if (p === null || typeof p !== 'object' || (p.kind !== 'invite' && p.kind !== 'approve') || typeof p.value !== 'string' || p.value === '' || typeof p.at !== 'number') {
    storage.remove(STAFF_FRAGMENT_KEY);
    return null;
  }
  if (p.kind !== kind) return null;
  if (!(p.at <= now && now - p.at <= STAFF_FRAGMENT_TTL_MS)) {
    storage.remove(STAFF_FRAGMENT_KEY);
    return null;
  }
  return p.value;
}

/**
 * 조회가 성공해 지운 값을 화면이 다시 로그인하러 떠나기 전에 되돌려 둔다(수락 직전에 세션이 끝난 경우, 돌아와 같은 탭에서 잇게).
 * 남긴 시각은 지금이다(10분 [가정] 안에 돌아와야 한다)
 */
export function keepStaffFragment(storage: StaffFragmentStorage, kind: StaffFragmentKind, value: string, now: number): void {
  if (value === '') return;
  storage.set(STAFF_FRAGMENT_KEY, JSON.stringify({ kind, value, at: now }));
}

/** 조회가 성공했거나 값을 더 쓸 수 없을 때 지운다. 다른 화면의 값은 그대로 둔다 */
export function clearStaffFragment(storage: StaffFragmentStorage, kind: StaffFragmentKind): void {
  const v = storage.get(STAFF_FRAGMENT_KEY);
  if (v === null) return;
  try {
    const p = JSON.parse(v) as { kind?: unknown };
    if (p && typeof p === 'object' && p.kind !== kind && (p.kind === 'invite' || p.kind === 'approve')) return;
  } catch {
    // 모양이 틀린 값은 지운다
  }
  storage.remove(STAFF_FRAGMENT_KEY);
}

/** 로그인 화면 주소. next에는 그 화면의 경로만 싣는다(쿼리·조각·토큰 없음, d5 §5.26 끝 문단) */
export function staffLoginHref(path: '/staff/invitations' | '/staff/approve' | '/staff'): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
