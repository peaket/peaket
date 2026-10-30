// SCR-041 양도 받기: 상태별로 보이는 것(캔버스 보드 SCR-041-m renderVals를 그대로 옮겼다)과 상태별 안내 띠·배지 글.
import type { BadgeTone } from '@peaket/ds/Badge';
import type { Scr041State } from '@/shared/config/screens.booking';

export interface OfferView {
  /** 받기·거절 */
  waiting: boolean;
  /** 받은 뒤 등록 안내 */
  accepted: boolean;
  /** 남의 요청(404): 카드 없이 잠금 안내만 */
  denied: boolean;
  /** 마이 티켓으로 가기 링크 */
  closed: boolean;
  /** 맨 위 안내 띠(받은 뒤는 success, 나머지는 danger) */
  banner: { tone: 'success' | 'danger'; title: string; body: string } | null;
  /** 카드 상태 배지 */
  badge: { label: string; tone: BadgeTone } | null;
  /** 카드 아래 수락 기한 줄: 남음 · 지남 · 없음 */
  deadline: 'active' | 'expired' | null;
}

const BANNERS: Partial<Record<Scr041State, OfferView['banner']>> = {
  '수락 완료': { tone: 'success', title: '티켓을 받았습니다', body: '입장할 휴대폰에서 등록해야 QR이 나옵니다' },
  '기한 만료': {
    tone: 'danger',
    title: '기한이 지난 요청입니다',
    body: '수락 기한이 지나 이 요청으로는 받을 수 없습니다. 티켓은 보낸 분에게 그대로 있습니다.',
  },
  철회됨: { tone: 'danger', title: '보낸 분이 요청을 철회했습니다', body: '이 요청으로는 받을 수 없습니다. 티켓은 보낸 분에게 그대로 있습니다.' },
  '공연 취소로 철회됨': {
    tone: 'danger',
    title: '공연이 취소되어 철회된 요청입니다',
    body: '이 요청은 더 이상 받을 수 없습니다. 이 티켓은 결제하신 분(보낸 분)께 전액 환급됩니다. 티켓값을 미리 주고받으셨다면 보낸 분과 직접 정산해 주세요.',
  },
  '일정 변경으로 철회됨': {
    tone: 'danger',
    title: '공연 일정이 바뀌어 철회된 요청입니다',
    body: '이 요청은 더 이상 받을 수 없습니다. 보낸 분이 바뀐 일정으로 다시 양도를 요청하면 새 요청을 다시 알려 드립니다.',
  },
  처리됨: {
    tone: 'danger',
    title: '이미 처리된 요청입니다',
    body: '이미 받거나 거절한 요청이라 다시 처리할 수 없습니다. 받은 티켓은 마이 티켓에서 볼 수 있습니다.',
  },
  '입장 시작': {
    tone: 'danger',
    title: '입장이 시작되어 지금은 받을 수 없습니다',
    body: '입장이 시작된 뒤에는 티켓을 주고받을 수 없습니다. 티켓은 보낸 분에게 그대로 있습니다.',
  },
};

const BADGES: Partial<Record<Scr041State, OfferView['badge']>> = {
  요청: { label: '수락 대기', tone: 'warning' },
  '수락 완료': { label: '받은 티켓', tone: 'primary' },
  '기한 만료': { label: '기한 지남', tone: 'neutral' },
  철회됨: { label: '철회됨', tone: 'neutral' },
  '공연 취소로 철회됨': { label: '철회됨', tone: 'neutral' },
  '일정 변경으로 철회됨': { label: '철회됨', tone: 'neutral' },
  처리됨: { label: '처리됨', tone: 'neutral' },
  '입장 시작': { label: '받을 수 없음', tone: 'neutral' },
};

export function offerView(st: Scr041State): OfferView {
  const waiting = st === '요청';
  const accepted = st === '수락 완료';
  const denied = st === '권한 없음';
  return {
    waiting,
    accepted,
    denied,
    closed: !waiting && !accepted,
    banner: BANNERS[st] ?? null,
    badge: BADGES[st] ?? null,
    deadline: waiting ? 'active' : st === '기한 만료' ? 'expired' : null,
  };
}
