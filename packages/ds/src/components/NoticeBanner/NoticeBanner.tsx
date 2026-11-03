// CMP-017 NoticeBanner. 캔버스 키트 10절 .banner 마크업을 그대로 낸다. 서버 컴포넌트에서도 쓴다.
// - tone: info · warning · danger · success · announce(운영 공지) · legal(법정 고지) · offline
// - 아이콘은 tone마다 정해진 것을 쓴다(바꾸려면 icon). 제목은 .banner-title, 본문은 .banner-body.
// - tag: 본문 앞 작은 꼬리표(.legal-tag, '법정 고지'). 법정 고지 문구는 POL 원문을 한 글자도 바꾸지 않는다.
// - strip: 화면 폭 띠(.banner-strip, 모서리 없음).
// - role: 기본 status. 바로 알려야 하는 오류는 alert. 정적 안내(법정 고지 등)는 role 없이 둔다(role={null}).
// - action: 오른쪽 끝 버튼·링크(닫기 버튼 등). 닫기는 공지 정책에 따라 화면이 고른다.
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success' | 'announce' | 'legal' | 'offline';

const toneIcon: Record<BannerTone, IconName> = {
  info: 'info',
  warning: 'alert',
  danger: 'alert-circle',
  success: 'check-circle',
  announce: 'megaphone',
  legal: 'scale',
  offline: 'wifi-off',
};

export interface NoticeBannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: IconName;
  tag?: ReactNode;
  strip?: boolean;
  role?: 'status' | 'alert' | null;
  action?: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

export function NoticeBanner({
  tone = 'info',
  title,
  children,
  icon,
  tag,
  strip = false,
  role = 'status',
  action,
  id,
  className,
  style,
}: NoticeBannerProps) {
  return (
    <div
      id={id}
      className={cx('banner', `banner-${tone}`, strip && 'banner-strip', className)}
      role={role ?? undefined}
      style={style}
    >
      <Icon name={icon ?? toneIcon[tone]} />
      <div className="banner-body">
        {title ? <span className="banner-title">{title}</span> : null}
        {tag ? <span className="legal-tag">{tag}</span> : null}
        {children}
      </div>
      {action}
    </div>
  );
}
