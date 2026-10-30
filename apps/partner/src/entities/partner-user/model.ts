// 파트너 계정 목업(d5 §6.1 '그림 예의 사람'). 로그인한 사람은 (주)스텔라엔터테인먼트의 파트너 관리자 한 명이다.
import type { PartnerRole } from '@peaket/ds/PartnerShell';

export type { PartnerRole } from '@peaket/ds/PartnerShell';
export { PARTNER_ROLE_LABEL } from '@peaket/ds/PartnerShell';

export interface PartnerUser {
  id: string;
  /** 표시 이름(역할 이름과 다르게 둔다, ADR-0163) */
  displayName: string;
  emailMasked: string;
  role: PartnerRole;
  status: '활성' | '초대 대기' | '잠김';
  /** '10/14(수) 19:20 KST' */
  lastSeenAt: string;
  isMe?: boolean;
}

export const me = {
  id: 'pu-ops',
  displayName: '파트너 담당자',
  /** 로그인 2단계에 보이는 이메일(합성 도메인) */
  email: 'ops@stella.example',
  emailMasked: 'op***@stella.example',
  avatarText: '스',
  role: 'partner_admin' as PartnerRole,
};

export const team: readonly PartnerUser[] = [
  {
    id: me.id,
    displayName: me.displayName,
    emailMasked: me.emailMasked,
    role: 'partner_admin',
    status: '활성',
    lastSeenAt: '10/14(수) 19:20 KST',
    isMe: true,
  },
  {
    id: 'pu-tk',
    displayName: '티켓 실무 담당',
    emailMasked: 'tk***@stella.example',
    role: 'partner_member',
    status: '활성',
    lastSeenAt: '10/13(화) 18:05 KST',
  },
];

/** 관리자만 하는 일을 실무자가 누를 때 보이는 이유 글(d5 §3.2) */
export const ADMIN_ONLY_REASON = '이 작업은 파트너 관리자만 할 수 있습니다';
