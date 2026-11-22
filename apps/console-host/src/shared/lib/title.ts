// 화면 제목(<title>). 경로가 바뀔 때 새 화면 이름을 알린다(docs/frontend.md §2.7).
// 브라우저 탭을 숨긴 동안 걸린 SEV1·SEV2 경보나 내 승인 대기가 있으면 제목 앞에 그 수를 붙인다(예: `(SEV1 1 · 승인 1) 대시보드 · PEAKET 관제`,
// 없으면 붙이지 않는다, docs/frontend.md §5.7 '멈추지 않는 것', d5 §3.3, ADR-0091 결정 3). 수는 늘 여는 흐름이 채우는 호스트 저장소에서 읽는다.
import { useEffect } from 'react';
import type { HostAlert } from '@peaket/console-contract';
import { hostStore } from '@/shared/model/live-host';

let base = 'PEAKET 관제';
let watching = false;

/** 숨긴 탭 제목 앞에 붙일 수(없으면 빈 글) */
export function hiddenTitlePrefix(s: { alerts: readonly Pick<HostAlert, 'status' | 'severity'>[]; commands: { pending: readonly unknown[] } }): string {
  const firing = s.alerts.filter((a) => a.status === 'firing');
  const sev1 = firing.filter((a) => a.severity === 'SEV1').length;
  const sev2 = firing.filter((a) => a.severity === 'SEV2').length;
  const approvals = s.commands.pending.length;
  const parts = [...(sev1 ? [`SEV1 ${sev1}`] : []), ...(sev2 ? [`SEV2 ${sev2}`] : []), ...(approvals ? [`승인 ${approvals}`] : [])];
  return parts.length > 0 ? `(${parts.join(' · ')}) ` : '';
}

function render(): void {
  if (typeof document === 'undefined') return;
  const prefix = document.visibilityState === 'hidden' ? hiddenTitlePrefix(hostStore.getState()) : '';
  const next = `${prefix}${base}`;
  if (document.title !== next) document.title = next;
}

function watch(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('visibilitychange', render);
  hostStore.subscribe(() => {
    if (document.visibilityState === 'hidden') render();
  });
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    base = `${title} · PEAKET 관제`;
    watch();
    render();
  }, [title]);
}
