'use client';
// SCR-061 실제 화면을 첫 묶음에서 빼고 늦게 싣는다(docs/frontend.md §5.8). 실제 화면은 API를 쓰는 클라이언트 화면이라 서버 그리기에 기대지 않는다(ssr: false).
// 미리보기(?state=)는 StaffHomePage가 지금처럼 서버에서 그린다.
import dynamic from 'next/dynamic';
import { AppShell } from '@/widgets/app-shell';

const StaffHomeLive = dynamic(() => import('./StaffHomeLive').then((m) => m.StaffHomeLive), {
  ssr: false,
  loading: () => <LiveLoading />,
});

export function StaffHomeLiveLoader() {
  return <StaffHomeLive />;
}

/** 실행부를 받는 동안의 뼈대(조회 중과 같은 모양) */
function LiveLoading() {
  return (
    <AppShell variant="staff" staff={{ closeHref: '/' }}>
      <main className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8 lg:pt-12 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-7">
          <h1 className="t-xl">내 현장 배정</h1>
          <p className="t-sm muted" role="status">
            배정을 불러오는 중입니다
          </p>
        </div>
      </main>
    </AppShell>
  );
}
