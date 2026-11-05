// SCR-059 시스템 안내 '404'(d5 §5.33, 보드 SCR-059 '404'). 묶음별 not-found.tsx와 global-not-found.tsx가 함께 쓴다.
// 상태 표시(404)를 함께 그린다(ADR-0201). 앞 서버는 위 서버가 200인 HTML에서만 그 표시로 상태를 맞춘다. 화면 안 notFound()는 이 화면이
// 화면 데이터로만 흘러 표시가 HTML에 실리지 않으므로, 없는 값이 많이 오는 경로는 proxy가 먼저 거른다(공연 상세, ADR-0201 결정 3).
import { AppShell } from '@/widgets/app-shell';
import { SystemNoticeCard, SystemNoticeMain } from './SystemNoticeCard';

export function NotFoundScreen() {
  return (
    <AppShell>
      <meta name="peaket-status" content="404" />
      <SystemNoticeMain>
        <SystemNoticeCard variant="404" />
      </SystemNoticeMain>
    </AppShell>
  );
}
