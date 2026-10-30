// Next.js 16 페이지 props(params·searchParams는 Promise). 퍼블리싱 상태는 searchParams의 ?state=·?theme=로 고른다.
export type SearchParams = Record<string, string | string[] | undefined>;

export interface PageProps<P extends Record<string, string> = Record<string, never>> {
  params: Promise<P>;
  searchParams: Promise<SearchParams>;
}

/** 검색 값 하나(배열이면 첫 값) */
export function firstParam(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}
