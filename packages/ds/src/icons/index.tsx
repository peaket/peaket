// 피켓 선 아이콘(d2 §1 'UI 아이콘'). 캔버스 키트(kit.css 5절)가 CSS 마스크로 그리므로 React에서는
// <i class="ic ic-이름" aria-hidden="true"></i>를 내는 부품 하나만 둔다. 글자색(currentColor)을 따른다.
// - 이름 목록은 kit.css 5절의 .ic-* 규칙과 같다(119개). 장르 아이콘 10개는 docs/design/icons/genre/의 정본 SVG와 같은 그림이다(2026-10-31 대조).
// - 크기 기본은 20px(키트 .ic). size로 14·16·24·28·32·48·64를 고른다. 버튼·배지 안에서는 키트가 크기를 정한다.
// - 장식 아이콘은 aria-hidden이다. 뜻을 전해야 하면 label을 준다(role="img"). 아이콘만 있는 버튼은 버튼에 이름을 붙인다(IconButton).
// 서버 컴포넌트에서도 쓴다.
import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';

export const iconNames = [
  'search', 'ticket', 'menu', 'user', 'users', 'bell', 'heart', 'heart-fill', 'share', 'chevron-right',
  'chevron-left', 'chevron-down', 'chevron-up', 'arrow-left', 'arrow-right', 'close', 'check', 'plus',
  'minus', 'info', 'alert', 'alert-circle', 'check-circle', 'x-circle', 'help', 'ban', 'stop', 'wifi',
  'wifi-off', 'clock', 'history', 'calendar', 'pin', 'shield', 'lock', 'key', 'copy', 'external', 'link',
  'refresh', 'home', 'settings', 'logout', 'qr', 'scan', 'phone', 'device', 'mail', 'bag', 'box', 'star',
  'star-fill', 'genre-concert', 'genre-musical', 'genre-theater', 'genre-classic', 'genre-festival',
  'genre-fanmeeting', 'genre-etc', 'genre-goods', 'genre-venue', 'genre-all', 'flag', 'filter', 'sort',
  'download', 'upload', 'eye', 'eye-off', 'chart', 'pulse', 'bolt', 'building', 'wheelchair', 'more', 'grip',
  'undo', 'redo', 'play', 'pause', 'globe', 'sun', 'doc', 'bank', 'receipt', 'won', 'transfer', 'edit',
  'trash', 'image', 'zoom-in', 'zoom-out', 'list', 'grid', 'map', 'megaphone', 'scale', 'inbox', 'stamp',
  'bot', 'code', 'signal', 'hand', 'battery', 'monitor', 'tablet', 'cart', 'bell-fill', 'cursor', 'rect',
  'polygon', 'sector', 'arcband', 'seat', 'wand', 'mirror', 'rotate', 'layers', 'handle',
] as const;

export type IconName = (typeof iconNames)[number];

/** 키트 크기 클래스(.ic-14 …). 20은 기본 크기라 클래스를 붙이지 않는다 */
export type IconSize = 14 | 16 | 20 | 24 | 28 | 32 | 48 | 64;

export interface IconProps {
  name: IconName;
  size?: IconSize;
  /** 뜻을 전하는 아이콘일 때만 준다(role="img"와 aria-label). 없으면 장식(aria-hidden) */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** 아이콘 클래스 문자열('ic ic-search ic-16'). 마크업을 직접 쓸 때 */
export function iconClass(name: IconName, size?: IconSize): string {
  return cx('ic', `ic-${name}`, size && size !== 20 && `ic-${size}`);
}

export function Icon({ name, size, label, className, style }: IconProps) {
  if (label) {
    return <i className={cx(iconClass(name, size), className)} style={style} role="img" aria-label={label} />;
  }
  return <i className={cx(iconClass(name, size), className)} style={style} aria-hidden="true" />;
}
