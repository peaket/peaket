// CMP-046 PermissionDenied. 권한이 부족함과 그 사유를 밝히고, 로그인하거나 돌아가는 길을 준다(role="alert"). 서버 컴포넌트에서도 쓴다.
// - variant: page(화면 전체) · inline(구역 안)
// - actions: [로그인]·[이전 화면으로] 같은 링크. 사유는 description에 적는다(어느 역할이 필요한지 등).
import type { ReactNode } from 'react';
import { StateBlock, type StateBlockProps } from '../EmptyState/StateBlock';

export interface PermissionDeniedProps extends Omit<StateBlockProps, 'role' | 'title'> {
  title?: ReactNode;
}

export function PermissionDenied({
  icon = 'lock',
  tone = 'neutral',
  title = '이 화면을 볼 권한이 없습니다',
  variant = 'page',
  ...rest
}: PermissionDeniedProps) {
  return <StateBlock role="alert" icon={icon} tone={tone} title={title} variant={variant} {...rest} />;
}
