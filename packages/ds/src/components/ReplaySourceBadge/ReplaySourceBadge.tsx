// CMP-082 ReplaySourceBadge(d2 CMP-082). 포렌식 리플레이(SCR-069)가 지금 연 데이터 원천을 머리에 늘 보인다.
// 한 화면에는 원천 하나뿐이고 화면 안에서 바꾸지 못한다(조사·연구 두 갈래를 잇지 않는다, ADR-0171 결정 2). 그래서 단추가 아니라 글자 배지다.
// - 배지 글자가 원천 이름이다(색만으로 가르지 않는다). 조사·연구는 아이콘도 달리 붙인다: 조사는 방패(지정 조사관만 여는 기록), 연구는 가린 눈(가명 기록).
// - 합성 데이터는 보드 SCR-069의 badge-warning 모양 그대로다.
// - 화면 제목(h1, 화면 낭독기용)에도 원천을 넣는다. 그것은 화면 쪽 몫이다.
// 서버 컴포넌트에서도 쓴다.
import type { HTMLAttributes } from 'react';
import type { IconName } from '../../icons';
import { Badge, type BadgeTone } from '../Badge/Badge';

export type ReplaySource = 'investigation' | 'research' | 'synthetic';

/** 배지 글자(d2 CMP-082 변형 investigation(조사)·research(연구)·synthetic(합성 데이터)) */
export const replaySourceLabel = {
  investigation: '조사',
  research: '연구',
  synthetic: '합성 데이터',
} as const satisfies Record<ReplaySource, string>;

const LOOK: Record<ReplaySource, { tone: BadgeTone; icon?: IconName }> = {
  investigation: { tone: 'danger', icon: 'shield' },
  research: { tone: 'primary', icon: 'eye-off' },
  synthetic: { tone: 'warning' },
};

export interface ReplaySourceBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  source: ReplaySource;
}

export function ReplaySourceBadge({ source, ...rest }: ReplaySourceBadgeProps) {
  const look = LOOK[source];
  return (
    <Badge tone={look.tone} icon={look.icon} data-source={source} {...rest}>
      {replaySourceLabel[source]}
    </Badge>
  );
}
