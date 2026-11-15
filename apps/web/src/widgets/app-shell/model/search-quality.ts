// 검색 품질 사건 수(docs/features/search.md §11, catalog-review 14.2.3). 검색어 없이 사건 수만 같은 출처 수집 경로(`/_t/rum`)로 60초 [가정]마다 묶어 보낸다.
// BAT-165 웨이브 7 시험 담당이 둔 빈 뼈대다. 구현 담당이 채우고 검색 결과·자동완성 부품이 부른다.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).

export interface SearchQuality {
  resultsShown(zero: boolean): void;
  suggestShown(): void;
  suggestSelected(kind: 'PRODUCTION' | 'ARTIST' | 'PLACE', position: number): void;
  resultClick(position: number): void;
  requery(): void;
  flush(): Promise<void>;
}

export function createSearchQuality(_o: { send(path: string, body: string): Promise<void>; now(): number }): SearchQuality {
  throw new Error('아직 없음');
}
