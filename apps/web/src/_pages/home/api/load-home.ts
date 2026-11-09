// 홈 피드 읽기(서버, 빌드·ISR 때. docs/frontend.md §2.5 '/' 행, openapi getHome, ADR-0199 결정 3, BUILD_ORDER HOT-300).
// - 'use cache' + cacheLife 60초 + cacheTag('home'): 홈 구성 저장·판매 승인·매진 때 home 태그를 무효화한다.
// - 서버 API 주소(PEAKET_API_ORIGIN)가 없으면 부르지 않고 빈 피드로 그린다(섹션이 숨는다. CI 빌드처럼 원본이 없는 곳).
// - 주소가 있는데 원본이 실패하면 던진다. ISR 다시 만들기라면 Next.js가 마지막 정상 화면을 계속 낸다(SCR-001 '에러'). 첫 빌드라면 실패가 드러난다.
// - 홈 피드는 개인 값을 싣지 않는다. 찜·알림 상태는 브라우저가 따로 받는다(HomePersonal).
import { getHome } from '@peaket/api-client/endpoints/catalog';
import { cacheLife, cacheTag } from 'next/cache';
import { ensureServerApi } from '@/shared/api';
import { EMPTY_HOME, toHomeData, type HomeData } from '../model/feed';

export async function loadHome(): Promise<HomeData> {
  'use cache';
  cacheLife({ revalidate: 60 });
  cacheTag('home');
  if (!ensureServerApi()) return EMPTY_HOME;
  const r = await getHome();
  return toHomeData(r.data, new Date());
}
