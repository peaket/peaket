// SCR-058 외부 브라우저 전환 안내(d5 §5.32, d3 SCR-058 행, 캔버스 보드 SCR-058-m·t·d를 한 페이지 반응형으로 합쳤다).
// 집중 셸(머리: 닫기 · 공연명/회차 · 계정). 모든 크기에서 가운데 카드 한 열(휴대폰 꽉 찬 폭, 태블릿·데스크톱 최대 520).
// 주소: /open-in-browser?next=/queue/[eventId] (로비·대기열 직전) · ?next=/my/tickets/[ticketId] (입장용 휴대폰 등록 직전). 자리는 model/target.ts.
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { SCR058_STATES, type Scr058State } from '@/shared/config/screens.discovery';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { resolveTarget } from '../model/target';
import { OpenInBrowserCard } from './OpenInBrowserCard';

export async function OpenInBrowserPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const picked = firstParam(sp, 'state');
  const state: Scr058State | null = picked !== undefined ? resolvePreviewState(sp, SCR058_STATES, 'Android') : null;
  const dark = resolvePreviewTheme(sp) === 'dark';
  const target = resolveTarget(firstParam(sp, 'next'));
  return (
    <AppShell
      variant="focus"
      dark={dark}
      focus={{ title: target.title, subtitle: target.subtitle, closeHref: target.closeHref, closeLabel: target.closeLabel }}
    >
      <main className="page-main px-4 pt-6 pb-10 md:px-6 md:py-12 lg:px-8 lg:pt-14 lg:pb-20" id="main" tabIndex={-1}>
        <OpenInBrowserCard key={state ?? 'auto'} state={state} href={target.href} />
      </main>
      <PreviewSwitcher path="/open-in-browser" states={SCR058_STATES} current={state ?? 'Android'} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
