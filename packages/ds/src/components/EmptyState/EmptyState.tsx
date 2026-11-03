// CMP-043 EmptyState. 데이터가 없을 때 이유와 다음 행동을 함께 보인다. 서버 컴포넌트에서도 쓴다.
// 예: <EmptyState icon="ticket" title="예매한 티켓이 없습니다" description="…" actions={<ButtonLink href="/">공연 둘러보기</ButtonLink>} />
import { StateBlock, type StateBlockProps } from './StateBlock';

export type EmptyStateProps = Omit<StateBlockProps, 'role'>;

export function EmptyState({ icon = 'inbox', ...rest }: EmptyStateProps) {
  return <StateBlock icon={icon} {...rest} />;
}
