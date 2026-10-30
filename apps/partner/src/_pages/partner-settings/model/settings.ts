// 설정 화면 목업(보드 SCR-020 설정 구역의 값 그대로). 합성 데이터다.
import type { PartnerRole } from '@/entities/partner-user';

export const accountSecurity = {
  passwordChangedAt: '9/30(수)',
  totpRegisteredAt: '9/30',
  passkeys: [{ id: 'pk-1', name: '사무실 노트북', registeredAt: '10/2' }],
  recoveryCodesLeft: 7,
};

/** 로그인 기기(최대 2, CMP-052). 첫 줄이 이 기기(보드 데스크톱 그림 기준) */
export const loginDevices: readonly { id: string; icon: string; label: string; current?: boolean }[] = [
  { id: 'dev-1', icon: 'ic-monitor', label: 'Chrome · Windows · 20:01 KST', current: true },
  { id: 'dev-2', icon: 'ic-tablet', label: 'Safari · iPad · 10/13 18:20 KST' },
];

/** 판매자 정보 변경 요청 대화상자의 그림 예(대표자를 고른 상태) */
export const sellerChangeRequest = { checked: 'representative', requestedAt: '10/15' } as const;

/** 정산 계좌 변경 뒤 보류 끝날(그림 예) */
export const payoutHoldUntil = '10/20';

/** 팀 계정 표(보드 SCR-020 팀 계정 그대로 — 둘째 줄 이름·접속 시각은 보드 값) */
export const teamRows: readonly {
  id: string;
  name: string;
  isMe?: boolean;
  emailMasked: string;
  role: PartnerRole;
  status: '활성' | '초대 대기' | '잠김';
  lastSeenAt: string;
}[] = [
  { id: 'pu-ops', name: '파트너 담당자', isMe: true, emailMasked: 'op***@stella.example', role: 'partner_admin', status: '활성', lastSeenAt: '10/14(수) 19:20 KST' },
  { id: 'pu-tk', name: '파트너 실무자', emailMasked: 'tk***@stella.example', role: 'partner_member', status: '활성', lastSeenAt: '10/14(수) 18:05 KST' },
];
