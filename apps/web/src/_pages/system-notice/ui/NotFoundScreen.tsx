// SCR-059 시스템 안내 '404'(d5 §5.33, 보드 SCR-059 '404'). 묶음별 not-found.tsx와 global-not-found.tsx가 함께 쓴다.
import { AppShell } from '@/widgets/app-shell';
import { SystemNoticeCard, SystemNoticeMain } from './SystemNoticeCard';

export function NotFoundScreen() {
  return (
    <AppShell>
      <SystemNoticeMain>
        <SystemNoticeCard variant="404" />
      </SystemNoticeMain>
    </AppShell>
  );
}
