// 빈·오류·권한 없음 상태의 공통 모양(캔버스 키트 14절 .state·.state-icon). EmptyState·ErrorState·PermissionDenied가 쓴다.
// 보드 마크업: <div class="state"><span class="state-icon is-warning"><i class="ic ic-ban"></i></span><span class="badge">…</span>
//   <h1 class="t-lg">제목</h1><p class="t-md muted" style="max-width:440px">설명</p><a class="link-more">…</a></div>
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export type StateTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface StateBlockProps {
  icon?: IconName | null;
  tone?: StateTone;
  title: ReactNode;
  description?: ReactNode;
  /** 제목 위 배지(판매 중지 등) */
  badge?: ReactNode;
  /** 다음 행동(버튼·링크) */
  actions?: ReactNode;
  /** 제목 단계. 화면 전체가 이 상태면 1(화면마다 h1 하나), 구역 안이면 2·3 */
  headingLevel?: 1 | 2 | 3;
  /** inline: 키트 기본 여백 · page: 화면 전체(보드 padding 120 24 160) */
  variant?: 'inline' | 'page';
  role?: 'alert' | 'status';
  id?: string;
  className?: string;
  style?: CSSProperties;
}

export function StateBlock({
  icon,
  tone = 'neutral',
  title,
  description,
  badge,
  actions,
  headingLevel = 2,
  variant = 'inline',
  role,
  id,
  className,
  style,
}: StateBlockProps) {
  const H = `h${headingLevel}` as 'h1' | 'h2' | 'h3';
  return (
    <div
      id={id}
      className={cx('state', className)}
      role={role}
      style={variant === 'page' ? { padding: '120px 24px 160px', ...style } : style}
    >
      {icon ? (
        <span className={cx('state-icon', tone !== 'neutral' && `is-${tone}`)}>
          <Icon name={icon} />
        </span>
      ) : null}
      {badge}
      <H className="t-lg">{title}</H>
      {description ? (
        <p className="t-md muted" style={{ maxWidth: 440 }}>
          {description}
        </p>
      ) : null}
      {actions ? (
        <div className="row wrap" style={{ gap: 8, justifyContent: 'center' }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
