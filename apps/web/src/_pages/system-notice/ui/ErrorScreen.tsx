'use client';
// SCR-059 시스템 안내 '500'(d5 §5.33, 보드 SCR-059 '500'). 묶음별 error.tsx가 쓴다.
// 문구는 일반 안내만 쓰고 error.message·digest를 화면에 내지 않는다(ASVS 16.5.1, docs/api/guidelines.md §2).
import { AppShell } from '@/widgets/app-shell';
import { SystemNoticeCard, SystemNoticeMain } from './SystemNoticeCard';

export function ErrorScreen({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AppShell>
      <SystemNoticeMain>
        <SystemNoticeCard variant="500" onRetry={() => reset()} />
      </SystemNoticeMain>
    </AppShell>
  );
}
