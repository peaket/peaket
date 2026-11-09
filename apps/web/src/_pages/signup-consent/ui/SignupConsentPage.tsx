// SCR-005 가입 완료·동의(d5 §5.5, d3 SCR-005 행, 캔버스 보드 SCR-005-m·t·d를 한 페이지 반응형으로 합쳤다, ADR-0203).
// 처음 로그인 뒤 로그인 경로가 /signup/consent?next=<돌아갈 주소>로 보낸다(identity §2). 셸은 로그인 전 모양(머리만인 보드와 달리 셸이 바닥글을 그린다).
// 폼은 화면 스크립트가 그린다(SignupForm). 퍼블리싱 상태 미리보기(?state=)는 HOT-323에서 걷었다. 다크는 ?theme=dark.
import { resolvePreviewTheme } from '@peaket/ds/Preview';
import type { PageProps } from '@/shared/lib/page-props';
import { firstParam } from '@/shared/lib/page-props';
import { safeNext } from '@/shared/lib/safe-next';
import { AppShell } from '@/widgets/app-shell';
import { SignupForm } from './SignupForm';

export async function SignupConsentPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const dark = resolvePreviewTheme(sp) === 'dark';
  return (
    <AppShell dark={dark} guest>
      <main className="page-main" id="main" tabIndex={-1}>
        <SignupForm next={safeNext(firstParam(sp, 'next'))} />
      </main>
    </AppShell>
  );
}
