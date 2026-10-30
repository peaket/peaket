// SCR-040 화면 글과 목업 합치기(보드 SCR-040의 글, d5 §5.22). 공연 이름·매수 한도는 production, 합치기 제안 값은 provider 목업에서 읽는다.
import type { MergeCheck, MergeSummaryProps } from '@peaket/ds/MergeSummary';
import { getProduction } from '@/entities/production';
import { MERGE_CHECK_TITLES, MERGE_PROPOSAL, PROVIDER_NAME, type MergeBlockerCode } from '@/entities/provider';

/** 대표 계정 제공자(지민은 카카오로 가입했다) */
export const SURVIVOR_PROVIDER = 'kakao' as const;

/** 계정 설정 왼쪽 메뉴(데스크톱, SCR-017 하위 뷰). 다른 항목은 SCR-017의 구역으로 잇는다(구역 id는 추천안) */
export const SETTINGS_MENU = [
  { icon: 'user', label: '프로필', href: '/my/settings#profile' },
  { icon: 'shield', label: '휴대폰 본인확인', href: '/my/settings#verify' },
  { icon: 'device', label: '로그인한 기기', href: '/my/settings#devices' },
  { icon: 'key', label: '로그인 수단·계정 합치기', href: '/my/settings/providers', current: true },
  { icon: 'ban', label: '예매 제한', href: '/my/settings#restriction' },
  { icon: 'bell', label: '알림 수신', href: '/my/settings#notify' },
  { icon: 'doc', label: '개인정보 처리방침', href: '/policy/privacy' },
  { icon: 'logout', label: '회원 탈퇴', href: '/my/settings#withdraw' },
] as const;

/** MergeSummary에 넘길 글(상태·누름 처리 제외) */
export type MergeContent = Omit<MergeSummaryProps, 'status' | 'onDismiss' | 'continueAction' | 'className'> & {
  continueLabel: string;
  /** 재인증 뒤 확인 창 글 */
  confirm: { reauthed: string; title: string; note: string; confirmLabel: string; cancelLabel: string };
};

export function mergeContent(): MergeContent {
  const m = MERGE_PROPOSAL;
  const incoming = PROVIDER_NAME[m.incoming];
  const survivorName = PROVIDER_NAME[SURVIVOR_PROVIDER];
  const lumen = getProduction('prd-lumen');
  const title = lumen?.title ?? 'LUMEN 콘서트 2026 서울';
  const limit = lumen?.perPerson ?? 4;
  const total = m.blockedHeld.mine + m.blockedHeld.absorbed;

  const detail: Record<MergeBlockerCode, string> = {
    ACTIVE_PURCHASE: '해당 없음',
    QUOTA_EXCEEDED: `해당 · ${title} ${m.blockedHeld.mine}매 + ${m.blockedHeld.absorbed}매 = ${total}매, 한도 ${limit}매`,
    BOTH_VERIFIED: '해당 없음 · 지금 계정만 본인확인',
    WITHDRAWAL_OR_APPEAL: '해당 없음',
    ENTRY_STARTED: '해당 없음',
  };
  const checks: MergeCheck[] = (Object.keys(MERGE_CHECK_TITLES) as MergeBlockerCode[]).map((code) => ({
    title: MERGE_CHECK_TITLES[code],
    detail: detail[code],
    blocked: code === 'QUOTA_EXCEEDED',
  }));

  return {
    question: `${incoming} 계정은 이미 다른 PEAKET 계정입니다. 두 계정을 합칠까요? 합치면 되돌릴 수 없습니다`,
    blockedQuestion: `${incoming} 계정은 이미 다른 PEAKET 계정입니다`,
    survivor: m.survivor,
    absorbed: m.absorbed,
    moves: m.moves,
    movesNote: `흡수 계정의 주문 ${m.absorbedOrders}건은 원래 기록 그대로 두고 대표 계정의 '내 주문'에 함께 보입니다`,
    keeps: m.keeps.join(' · '),
    remaining: m.remaining,
    blockedReason: `${title}의 보유 매수가 한도 ${limit}매를 넘어 합칠 수 없습니다. 보유 매수를 한도 안으로 줄인 뒤 다시 추가해 주세요.`,
    checks,
    merging: {
      message: '처리 중입니다. 완료되면 알림으로 안내해 드립니다',
      progressLabel: '계정 합치기 진행',
      steps: [
        { label: `${incoming} 계정 잠금·로그아웃`, state: 'done' },
        { label: '로그인 수단·찜·알림·배송지 옮기는 중', state: 'active' },
        { label: '두 계정에 완료 알림', state: 'waiting' },
      ],
      note: '이 화면을 닫아도 처리는 계속됩니다.',
    },
    expiredText: '합치기 제안 시간이 지났습니다. 다시 추가해 주세요',
    continueLabel: `${survivorName}로 다시 로그인하고 계속`,
    confirm: {
      reauthed: `${survivorName}로 다시 로그인했습니다`,
      title: '두 계정을 합칩니다',
      note: `${m.keeps.join('과 ')}은 대표 계정 것을 그대로 씁니다. 합치면 되돌릴 수 없습니다.`,
      confirmLabel: '두 계정을 합칩니다. 되돌릴 수 없습니다',
      cancelLabel: '합치지 않고 닫기',
    },
  };
}
