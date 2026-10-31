// CMP-081 CaseStatusBadge(d2 CMP-081). 부정 예매 사건 상태·계정 소명 결과·점수 범주를 글자와 색으로 함께 보인다.
// 색만으로 뜻을 말하지 않는다(글자는 늘 있다). 점수 범주 앞에는 '점수'를 화면 낭독기용으로 붙인다. 서버 컴포넌트에서도 쓴다.
import type { HTMLAttributes } from 'react';
import { Badge } from '../Badge/Badge';
import { APPEAL_RESULT, CASE_STATUS, SCORE_BAND, type AppealResultValue, type CaseStatusValue, type ScoreBandValue } from './labels';

export type CaseStatusBadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> &
  (
    | { variant: 'case'; value: CaseStatusValue }
    | { variant: 'appeal'; value: AppealResultValue }
    | { variant: 'score'; value: ScoreBandValue }
  );

export function CaseStatusBadge(props: CaseStatusBadgeProps) {
  const { variant, value, ...rest } = props;
  const look =
    variant === 'case'
      ? CASE_STATUS[value as CaseStatusValue]
      : variant === 'appeal'
        ? APPEAL_RESULT[value as AppealResultValue]
        : SCORE_BAND[value as ScoreBandValue];
  return (
    <Badge tone={look.tone} data-variant={variant} data-value={value} {...rest}>
      {variant === 'score' ? <span className="sr-only">점수 범주 </span> : null}
      {look.label}
    </Badge>
  );
}
