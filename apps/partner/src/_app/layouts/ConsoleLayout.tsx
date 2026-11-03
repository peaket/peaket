// 로그인 뒤 화면 묶음 (console)의 레이아웃: 파트너 셸(CMP-065 partner)로 감싼다.
// 셸은 ?state=·?theme=·?role=을 읽는 클라이언트 부품(useSearchParams)이다. 이 묶음의 페이지는 모두 searchParams·params를 읽는 동적 페이지라
// Suspense 없이 둔다(Suspense를 두르면 notFound()의 404 상태 코드가 흐름 뒤로 밀린다). 정적 페이지를 더하면 그 페이지도 searchParams를 읽게 한다.
import type { ReactNode } from 'react';
import { ShellFrame } from '@/widgets/partner-shell';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ShellFrame>{children}</ShellFrame>;
}
