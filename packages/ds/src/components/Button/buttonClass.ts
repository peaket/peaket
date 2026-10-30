// 버튼 클래스 이름(캔버스 키트 7절 .btn). Button·ButtonLink와, 링크를 버튼 모양으로 그리는 화면 코드가 함께 쓴다.
import { cx } from '../../lib/cx';

/** primary·secondary·outline·ghost·text·danger·danger-outline, 제공자 버튼 kakao·naver·google(제공자 가이드 색, d2 §5) */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'text'
  | 'danger'
  | 'danger-outline'
  | 'kakao'
  | 'naver'
  | 'google';

/** sm 32 · md 40 · lg 52(모바일 핵심 행동) · xl 64 · field 56(스캐너 현장 주요 버튼, 버튼 사이 16px 이상) */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl' | 'field';

export type ProviderVariant = 'kakao' | 'naver' | 'google';

export function isProvider(variant: ButtonVariant): variant is ProviderVariant {
  return variant === 'kakao' || variant === 'naver' || variant === 'google';
}

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 줄 폭을 다 쓴다(.btn-block) */
  block?: boolean;
}

/** 'btn btn-primary btn-lg btn-block' 같은 클래스 문자열 */
export function buttonClass({ variant = 'primary', size = 'md', block = false }: ButtonClassOptions = {}): string {
  return cx('btn', `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block');
}
