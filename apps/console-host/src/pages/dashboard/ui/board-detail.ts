// 대시보드 보드(board-d) 위젯 머리 '자세히 보기 ↗'의 주소(F-03-3 OPS-380, ADR-0067).
// 실제 값 화면은 빌드 값의 Grafana(오류 위젯은 Sentry) 틀에 같은 회차·최근 15분을 담은 새 탭(opener 없음), 퍼블리싱 화면은 목업 주소 그대로다.
import { GRAFANA } from '@/entities/alert';
import { detailHref, NEW_TAB, recentRange } from '@/shared/lib/links';
import type { DashCtx } from './ctx';

export function boardDetail(ctx: Pick<DashCtx, 'live' | 'eventId'>, panel: string, kind: 'grafana' | 'sentry' = 'grafana'): { href: string; target: '_blank'; rel: string } {
  if (!ctx.live) return { href: GRAFANA, target: '_blank', rel: 'noreferrer' };
  const r = recentRange();
  return { href: detailHref({ kind, panel, eventId: ctx.eventId ?? null, fromMs: r.fromMs, toMs: r.toMs }), ...NEW_TAB };
}
