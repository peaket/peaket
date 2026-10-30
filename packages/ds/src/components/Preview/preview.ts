// 퍼블리싱 상태 고르기(add-screen-publishing design.md 결정 7). 라우터와 상관없는 순수 함수만 둔다.
// 상태 이름은 디자인 캔버스 보드의 `state` 열거값(한국어)을 그대로 쓴다. 데이터 연결 단계에서 걷어 낸다.

/** 주소의 검색 문자열에서 `?state=`를 읽어, 알려진 상태면 그것을, 아니면 기본값을 돌려준다 */
export function resolvePreviewState<S extends string>(
  search: string | URLSearchParams | Record<string, string | string[] | undefined> | undefined,
  states: readonly S[],
  fallback: S,
): S {
  const raw = readParam(search, 'state');
  return raw !== undefined && (states as readonly string[]).includes(raw) ? (raw as S) : fallback;
}

/** `?theme=dark`면 'dark', 아니면 'light' */
export function resolvePreviewTheme(
  search: string | URLSearchParams | Record<string, string | string[] | undefined> | undefined,
): 'light' | 'dark' {
  return readParam(search, 'theme') === 'dark' ? 'dark' : 'light';
}

/** 같은 화면의 다른 상태로 가는 주소. 다른 검색 값(예: `role`)은 남긴다 */
export function previewHref(path: string, state?: string, keep?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(keep ?? {})) if (v !== undefined && k !== 'state') params.set(k, v);
  if (state !== undefined) params.set('state', state);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

function readParam(
  search: string | URLSearchParams | Record<string, string | string[] | undefined> | undefined,
  key: string,
): string | undefined {
  if (search === undefined) return undefined;
  if (typeof search === 'string') return new URLSearchParams(search).get(key) ?? undefined;
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined;
  const v = search[key];
  return Array.isArray(v) ? v[0] : v;
}

/** 화면 목록(`/preview`)에 올리는 화면 하나 */
export interface PreviewScreen {
  /** 'SCR-001' */
  id: string;
  name: string;
  /** 목업 ID를 채운 실제 경로(예: '/events/evt-lumen-2026') */
  path: string;
  /** 캔버스 보드 state 열거값. 첫 값이 기본 상태 */
  states: readonly string[];
  /** 다른 앱(대기실 등)으로 가는 절대 주소면 true */
  external?: boolean;
  note?: string;
}
