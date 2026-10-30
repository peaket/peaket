// 아티스트 목업(지어낸 이름). 공연 등록 위저드 1단계의 '아티스트 찾기'가 읽는다.

export interface Artist {
  id: string;
  name: string;
  /** 다른 이름(영문 표기 등, 검색에만 쓴다) */
  aliases: readonly string[];
}

export const artists: readonly Artist[] = [
  { id: 'art-lumen', name: 'LUMEN', aliases: ['루멘'] },
  { id: 'art-nova', name: 'NOVA SEVEN', aliases: ['노바 세븐'] },
  { id: 'art-mono', name: '모노 앙상블', aliases: ['MONO ENSEMBLE'] },
];
