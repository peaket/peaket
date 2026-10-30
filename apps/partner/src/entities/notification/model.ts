// 셸 알림함·긴급 공지 목업(d5 §3.2 알림함, 보드 SCR-062 '긴급 공지 팝업').
import type { PartnerShellNotification, PartnerShellUrgentNotice } from '@peaket/ds/PartnerShell';

export const notifications: readonly PartnerShellNotification[] = [
  { id: 'n-1', title: '판매 승인 반려 · 가을 뮤지컬', meta: '사유: 통신판매업 신고번호 누락 · 10/12(월) 11:05 KST', href: '/events/evt-autumn-musical', tone: 'danger', unread: true },
  { id: 'n-2', title: '정산서 이의 기한 내일', meta: '10/15(목)까지 · 지난 공연 정산서 1건', tone: 'warning', unread: true },
  { id: 'n-3', title: '웹훅 수신 실패 3회', meta: '판매 요약 이벤트 · 10/14(수) 18:40 KST', href: '/settings/webhooks', tone: 'warning', unread: true },
  { id: 'n-4', title: '판매 승인 · LUMEN 콘서트 2026 서울', meta: '10/8(목) 14:20 KST', href: '/events/evt-lumen-2026', tone: 'success' },
];

export const urgentNotice: PartnerShellUrgentNotice = {
  title: '[발생] 오픈 직후 입장이 잠시 멈출 수 있습니다',
  meta: 'PEAKET 운영자 · 10/14(수) 19:42 KST',
  body: '10/14(수) 19:30 KST 오픈 전 점검에서 결제 대행사 상태 확인이 아직 끝나지 않았습니다. 20:00 오픈까지 확인되지 않으면 입장을 잠시 멈춘 채 판매를 시작하고, 확인되는 대로 입장을 이어 갑니다. 대기 순서와 판매 조건은 바뀌지 않습니다. 파트너께서 하실 일은 없습니다. 19:55 KST까지 다음 소식을 알려 드립니다.',
};
