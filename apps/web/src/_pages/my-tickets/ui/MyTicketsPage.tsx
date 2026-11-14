// SCR-013 마이 티켓(월렛) 목록(d5 §5.13, 캔버스 보드 SCR-013-m·t·d). 일반 셸(오프라인 캐시), (cached) 묶음.
// 보드처럼 다가오는 공연의 첫 티켓을 펼쳐 회전 QR을 보인다. 티켓 한 장의 상태(키 없음·저장소 유실 등)는 티켓 펼침 경로에서 고른다.
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { SCR013_LIST_STATES } from '@/shared/config/screens.booking';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { Wallet } from '@/widgets/ticket-wallet';

export async function MyTicketsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR013_LIST_STATES, '기본(QR 펼침)');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const path = '/my/tickets';
  return (
    <>
      <link rel="preload" as="image" href="/wallet-qr-skeleton.png" fetchPriority="high" />
      <AppShell dark={dark}>
        <Wallet state={state} path={path} dark={dark} />
        {process.env.NODE_ENV !== 'production' ? (
          <PreviewSwitcher path={path} states={SCR013_LIST_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
        ) : null}
      </AppShell>
    </>
  );
}
