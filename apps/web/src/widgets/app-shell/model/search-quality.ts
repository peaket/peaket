// 검색 품질 사건 수(docs/features/search.md §11, catalog-review 14.2.3). 검색어 없이 사건 수만 같은 출처 수집 경로(`/_t/rum`)로 60초 [가정]마다 묶어 보낸다.
// 사건을 부를 때 지난 보냄(처음엔 만든 때)에서 60초가 지났으면 그 사건까지 모은 수를 한 번에 보낸다. flush()는 모은 것이 있으면 바로 보낸다(화면을 떠날 때).
// 본문은 {"counters":[{"name","labels","value"}]}이고 라벨 값은 글이다. 위치·종류가 정해진 값 밖이면 버린다(라벨 수를 늘리지 않게).
// 바로 다시 찾음(search_requery_total, ADR-0271 결정 16)은 모듈이 센다: 결과를 보인 뒤 결과를 누르지 않고 10초 [가정] 미만에 정규화한 검색어가 다른 결과를 보이면 1.
// 쪽·필터·정렬만 바꾼 결과(검색어가 같다)는 세지 않는다. 검색어는 견주기에만 쓰고 보내지 않는다.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).

export interface SearchQuality {
  /** 검색 결과를 보였다. normalizedQuery는 정규화한 검색어(바로 다시 찾음을 가르는 데만 쓴다) */
  resultsShown(zero: boolean, normalizedQuery: string): void;
  suggestShown(): void;
  suggestSelected(kind: 'PRODUCTION' | 'ARTIST' | 'PLACE', position: number): void;
  resultClick(position: number): void;
  flush(): Promise<void>;
}

/** 묶어 보내는 간격(search.md:279, 60초 [가정]) */
export const SEARCH_QUALITY_WINDOW_MS = 60_000;
/** 같은 출처 수집 경로 */
export const SEARCH_QUALITY_PATH = '/_t/rum';
/** 바로 다시 찾음으로 세는 시간(search.md §11, 10초 [가정]) */
export const SEARCH_REQUERY_MS = 10_000;
const KINDS = new Set(['PRODUCTION', 'ARTIST', 'PLACE']);
/** 자동완성 후보 위치 1~8 */
const SUGGEST_POSITIONS = 8;

const bucketOf = (position: number): string | undefined => {
  if (!Number.isInteger(position) || position < 1) return undefined;
  if (position <= 3) return '1-3';
  if (position <= 10) return '4-10';
  if (position <= 20) return '11-20';
  return undefined;
};

export function createSearchQuality(o: { send(path: string, body: string): Promise<void>; now(): number }): SearchQuality {
  const counts = new Map<string, { name: string; labels: Record<string, string>; value: number }>();
  let sentAt = o.now();
  /** 마지막으로 보인 결과(검색어·시각)와 그 뒤 결과를 눌렀는지 */
  let lastShown: { query: string; at: number; clicked: boolean } | undefined;

  const send = async (): Promise<void> => {
    if (counts.size === 0) return;
    const body = JSON.stringify({ counters: [...counts.values()].map((c) => ({ name: c.name, labels: c.labels, value: c.value })) });
    counts.clear();
    sentAt = o.now();
    try {
      await o.send(SEARCH_QUALITY_PATH, body);
    } catch {
      // 품질 사건은 잃어도 된다(화면 동작을 바꾸지 않는다)
    }
  };

  const add = (name: string, labels: Record<string, string> = {}): void => {
    const key = `${name}${JSON.stringify(labels)}`;
    const c = counts.get(key);
    if (c) c.value += 1;
    else counts.set(key, { name, labels, value: 1 });
    if (o.now() - sentAt >= SEARCH_QUALITY_WINDOW_MS) void send();
  };

  return {
    resultsShown: (zero, normalizedQuery) => {
      const now = o.now();
      const prev = lastShown;
      lastShown = { query: normalizedQuery, at: now, clicked: false };
      add('search_results_shown_total', { zero: zero ? 'true' : 'false' });
      if (prev && !prev.clicked && prev.query !== normalizedQuery && now - prev.at < SEARCH_REQUERY_MS) add('search_requery_total');
    },
    suggestShown: () => add('search_suggest_shown_total'),
    suggestSelected: (kind, position) => {
      if (!KINDS.has(kind) || !Number.isInteger(position) || position < 1 || position > SUGGEST_POSITIONS) return;
      add('search_suggest_selected_total', { kind, position: String(position) });
    },
    resultClick: (position) => {
      const bucket = bucketOf(position);
      if (lastShown) lastShown.clicked = true;
      if (bucket) add('search_result_click_total', { position_bucket: bucket });
    },
    flush: send,
  };
}
