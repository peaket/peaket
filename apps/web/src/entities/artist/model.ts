// 아티스트 목업. 실존 아티스트 이름을 쓰지 않는다(d5 §10.3).
export interface Artist {
  id: string;
  name: string;
}

export const ARTISTS: readonly Artist[] = [
  { id: 'art-lumen', name: 'LUMEN' },
  { id: 'art-haneul-band', name: '하늘밴드' },
  { id: 'art-starlight-orch', name: '별빛 체임버 오케스트라' },
  { id: 'art-river-trio', name: '리버 재즈 트리오' },
];

export function getArtist(id: string): Artist | undefined {
  return ARTISTS.find((a) => a.id === id);
}
