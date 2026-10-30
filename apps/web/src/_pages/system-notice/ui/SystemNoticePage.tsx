// SCR-059 시스템 안내 상태 보기(/system-notice, 개발 서버에서만. 운영 빌드에서는 404 — /preview와 같은 규칙, add-screen-publishing design.md 결정 7).
// 실제로 쓰이는 자리: 404는 묶음별 not-found·global-not-found, 500은 묶음별 error.tsx, 판매 일시 중단은 앱 밖 정적 파일(public/sale-paused.html),
// 429·오프라인·미지원은 API 응답·서비스 워커·필수 기능 검사가 부르는 같은 카드다(오프라인 대체 경로는 서비스 워커 단계 HOT-390에서 정한다).
import { notFound } from 'next/navigation';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { SCR059_STATES } from '@/shared/config/screens.discovery';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { SystemNoticeCard, SystemNoticeMain } from './SystemNoticeCard';

export async function SystemNoticePage({ searchParams }: PageProps) {
  if (process.env.NODE_ENV === 'production') notFound();
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR059_STATES, '판매 일시 중단');
  const dark = resolvePreviewTheme(sp) === 'dark';
  return (
    <AppShell dark={dark} offline={state === '오프라인' ? { lastSync: '20:04' } : null}>
      <SystemNoticeMain>
        <SystemNoticeCard variant={state} />
      </SystemNoticeMain>
      <PreviewSwitcher path="/system-notice" states={SCR059_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
