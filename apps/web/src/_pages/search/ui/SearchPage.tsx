// SCR-003 검색(d5 §5.3, d3 SCR-003 행, planning/04 SCR-003, 캔버스 보드 SCR-003-m·t·d를 한 페이지 반응형으로 합쳤다).
// 검색 입력은 셸 머리 검색창 하나다(이 화면 본문에 두 번째 입력이 없다, ADR-0063·0094).
//   휴대폰·태블릿: 셸 머리가 처음부터 검색 모드다({ 검색창 } [취소], search.barOpen). [취소]는 앞 화면으로 돌아간다.
// 휴대폰: 필터 칩(가로 스크롤) → 결과 수·정렬 → 결과 줄(포스터 76) → 페이지 번호. 태블릿(md): 칩 줄바꿈, 결과 두 칸(포스터 92).
// 데스크톱(lg): 1280 상자 12칸 — 왼쪽 3칸 필터 패널, 오른쪽 9칸 결과(네 칸 포스터 카드).
// 데이터(docs/features/search.md §7.3, BUILD_ORDER HOT-312): 이 화면은 캐시되는 정적 셸이다(서버가 주소 값을 읽지 않아 빌드 때 그려진다).
// 브라우저가 주소를 읽어 검색 API를 부르고 결과를 그린다(SearchResults). 검색 엔진 색인에서 뺀다(noindex, follow).
// 머리 입력은 주소의 q를 화면 스크립트로 채운다(queryFromUrl, HOT-313).
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppShell } from '@/widgets/app-shell';
import { SearchResults, SearchShellSkeleton } from './SearchResults';

/** 검색 화면은 검색 엔진 색인에서 뺀다(noindex, follow, d5 §5.3) */
export const searchMetadata: Metadata = { title: '검색', robots: { index: false, follow: true } };

export function SearchPage() {
  return (
    // 캐시 화면이라 셸은 비로그인 모양으로 그린다(로그인 표시는 HOT-321)
    <AppShell variant="default" current="events" guest search={{ barOpen: true, queryFromUrl: true }}>
      <main className="page-main pb-10 md:px-6 md:pt-4 md:pb-12 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
        <h1 className="sr-only">공연 검색</h1>
        <Suspense fallback={<SearchShellSkeleton />}>
          <SearchResults />
        </Suspense>
      </main>
    </AppShell>
  );
}
