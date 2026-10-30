// CMP-045 ErrorState. 오류 원인과 해결 방법을 밝히고 바로 다시 시도하는 버튼을 둔다(role="alert"). 서버 컴포넌트에서도 쓴다.
// - variant: inline(구역 안) · page(화면 전체)
// - onRetry를 주면 [다시 시도](btn-primary)를 그린다(클라이언트 부품에서만 함수를 넘길 수 있다). 그 밖의 행동은 actions.
// - 과금 없는 실패면 설명에 "요금은 청구되지 않습니다"를 적는다(디자인 원칙 3).
import type { ReactNode } from 'react';
import { StateBlock, type StateBlockProps } from '../EmptyState/StateBlock';

export interface ErrorStateProps extends Omit<StateBlockProps, 'role' | 'title'> {
  title?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  icon = 'alert-circle',
  tone = 'danger',
  title = '불러오지 못했습니다',
  onRetry,
  retryLabel = '다시 시도',
  actions,
  ...rest
}: ErrorStateProps) {
  return (
    <StateBlock
      role="alert"
      icon={icon}
      tone={tone}
      title={title}
      actions={
        onRetry || actions ? (
          <>
            {onRetry ? (
              <button className="btn btn-primary" type="button" onClick={onRetry}>
                <i className="ic ic-refresh" aria-hidden="true" />
                {retryLabel}
              </button>
            ) : null}
            {actions}
          </>
        ) : undefined
      }
      {...rest}
    />
  );
}
