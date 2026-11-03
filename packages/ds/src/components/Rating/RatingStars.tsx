// 별점 보기(읽기 전용, 후기 목록·평균 별점). 보드 마크업: <span class="row" style="gap:1px" aria-hidden="true"> 안
// ic-star-fill(primary) · ic-star(text-disabled) 16px, 뒤에 화면 낭독기용 '5점 만점에 N점'. 서버 컴포넌트에서도 쓴다.
// 소수 평균(4.6)은 반올림한 개수만큼 채운다. 숫자는 화면이 옆에 따로 보인다.
import { Icon, type IconSize } from '../../icons';

export interface RatingStarsProps {
  value: number;
  max?: number;
  size?: IconSize;
  /** 낭독 글 앞말. 기본 '' → '5점 만점에 4점', '평균 별점' → '평균 별점 5점 만점에 4.6점' */
  prefix?: string;
}

export function RatingStars({ value, max = 5, size = 16, prefix = '' }: RatingStarsProps) {
  const filled = Math.round(value);
  return (
    <>
      <span className="row" style={{ gap: 1 }} aria-hidden="true">
        {Array.from({ length: max }, (_, i) =>
          i < filled ? (
            <Icon key={i} name="star-fill" size={size} style={{ color: 'var(--primary)' }} />
          ) : (
            <Icon key={i} name="star" size={size} style={{ color: 'var(--text-disabled)' }} />
          ),
        )}
      </span>
      <span className="sr-only">
        {prefix ? `${prefix} ` : ''}
        {max}점 만점에 {value}점
      </span>
    </>
  );
}
