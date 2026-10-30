'use client';
// 찜(공연 단위, ADR-0093) 토글(d5 §5.2 ⑫). aria-pressed로 상태를 알리고 이름 '찜하기'는 그대로다. 하트 모양이 바뀐다.
// 로그인 전이면 로그인(SCR-004)으로 간다. 누르면 토스트. 데이터 연결 단계에서 찜 API를 붙인다.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast } from '@/shared/ui/toast';

export interface LikeToggleProps {
  defaultPressed?: boolean;
  guest?: boolean;
  loginHref?: string;
  /** icon: 아이콘 외곽 버튼(휴대폰·태블릿) · outline: '찜하기' 글자 버튼(데스크톱) */
  variant?: 'icon' | 'outline';
  className?: string;
}

export function LikeToggle({ defaultPressed = false, guest = false, loginHref = '/login', variant = 'icon', className }: LikeToggleProps) {
  const [pressed, setPressed] = useState(defaultPressed);
  const toast = useToast();
  const router = useRouter();
  function onClick() {
    if (guest) {
      router.push(loginHref);
      return;
    }
    setPressed((v) => !v);
    toast(pressed ? '찜을 해제했습니다' : '찜했습니다', pressed ? 'ic-heart' : 'ic-heart-fill');
  }
  const icon = (
    <i className={`ic ${pressed ? 'ic-heart-fill' : 'ic-heart'}`} aria-hidden="true" style={pressed ? { color: 'var(--danger)' } : undefined} />
  );
  if (variant === 'icon') {
    return (
      <button className={['icon-btn icon-btn-outline', className ?? ''].join(' ').trim()} type="button" aria-pressed={pressed} aria-label="찜하기" onClick={onClick}>
        {icon}
      </button>
    );
  }
  return (
    <button className={['btn btn-outline btn-sm', className ?? ''].join(' ').trim()} type="button" aria-pressed={pressed} onClick={onClick}>
      {icon}찜하기
    </button>
  );
}
