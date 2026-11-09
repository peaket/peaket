// SCR-006 본인확인 흐름의 복귀 화면(d5 §5.6, d3 SCR-006 행, docs/features/identity.md §5 '모의 기관과 기관 창 흐름').
// 기관이 새 창 대신 페이지 이동으로 결과를 돌려줄 때 셸 머리만 두고 진행 표시를 보인다. 나머지 상태(기관 창·결과 대화상자)는
// 부르는 화면(공연 상세·가입 완료·설정 등) 위에서 실제로 돈다(@/features/identity-verify). 퍼블리싱 상태 미리보기(?state=)와
// 그 미리보기의 목업 부르는 화면은 HOT-323에서 걷었다. 다크는 ?theme=dark.
import { headers } from 'next/headers';
import { resolvePreviewTheme } from '@peaket/ds/Preview';
import { decodeAgencyFields, RETURN_HEADER } from '@/features/identity-verify/server/return-post';
import type { PageProps } from '@/shared/lib/page-props';
import { AppShell } from '@/widgets/app-shell';
import { VerifyReturnLive } from './VerifyReturnLive';

export async function VerifyReturnPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const dark = resolvePreviewTheme(sp) === 'dark';
  // 서버 처리기(apps/web/proxy.ts)가 넘긴 기관 값을 스크립트에 싣는다.
  // 값은 React가 화면 데이터로 직렬화한다(`</script>`·U+2028 등 이스케이프, ASVS v5.0.0-1.2.3). 저장·로그하지 않는다
  const posted = decodeAgencyFields((await headers()).get(RETURN_HEADER));
  return (
    // 복귀 화면은 로고만 있는 머리, 바닥글 없음(보드 SCR-006 '복귀 화면')
    <AppShell variant="minimal" dark={dark} footer={false}>
      <VerifyReturnLive posted={posted} />
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="center px-8 py-[120px] md:py-[160px]" style={{ flex: 1 }}>
          <h1 className="sr-only">본인확인 결과 확인</h1>
          <div className="col w-full max-w-[280px] md:max-w-[320px] lg:max-w-[360px]" role="status" style={{ gap: 16, alignItems: 'center', textAlign: 'center' }}>
            <div className="progress indet" aria-hidden="true">
              <span />
            </div>
            <p className="t-md fw-b">본인확인 결과를 확인하는 중입니다</p>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
