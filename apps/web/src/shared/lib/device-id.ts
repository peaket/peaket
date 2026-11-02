// 기기 식별값 deviceId(docs/frontend.md §3.12: localStorage `peaket.device`, CSPRNG 128비트, base64url 22자). 처음 쓸 때 만든다.
// 키 소지 증명이 아니라 새 기기 알림·로그인한 기기 목록·위험 신호에만 쓰는 값이다(docs/features/identity.md §7). 브라우저에서만 부른다.
const KEY = 'peaket.device';
const SHAPE = /^[A-Za-z0-9_-]{22}$/;

function fresh(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 저장소를 쓸 수 없으면(사생활 보호 모드 등) undefined: 그 로그인은 기기 행 없이 세션만 만든다 */
export function deviceId(): string | undefined {
  try {
    const v = localStorage.getItem(KEY);
    if (v && SHAPE.test(v)) return v;
    const made = fresh();
    localStorage.setItem(KEY, made);
    return made;
  } catch {
    return undefined;
  }
}
