'use client';
// 찜(공연 단위, ADR-0093) 토글(d5 §5.2 ⑫). aria-pressed로 상태를 알리고 이름 '찜하기'는 그대로다. 하트 모양이 바뀐다.
// - 로그인 전이면 로그인(SCR-004)으로 간다. 누르면 토스트.
// - onToggle을 넘기면 서버 값(pressed)을 따르고, 누르는 즉시 바뀐 모양을 보인 뒤(낙관적 갱신) 실패하면 되돌리고 토스트를 띄운다(HOT-311).
//   상태를 받기 전(disabled)에는 누를 수 없다(aria-disabled).
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast } from '@/shared/ui/toast';

export interface LikeToggleProps {
  defaultPressed?: boolean;
  /** 서버 값(onToggle과 함께) */
  pressed?: boolean;
  /** 저장·해제. 성공하면 true, 실패하면 보일 문구 */
  onToggle?: (next: boolean) => Promise<true | string>;
  /** 상태를 아직 모른다 */
  disabled?: boolean;
  guest?: boolean;
  loginHref?: string;
  /** icon: 아이콘 외곽 버튼(휴대폰·태블릿) · outline: '찜하기' 글자 버튼(데스크톱) */
  variant?: 'icon' | 'outline';
  className?: string;
}

export function LikeToggle({ defaultPressed = false, pressed: outer, onToggle, disabled = false, guest = false, loginHref = '/login', variant = 'icon', className }: LikeToggleProps) {
  const [local, setLocal] = useState(defaultPressed);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const pressed = optimistic ?? outer ?? local;
  const toast = useToast();
  const router = useRouter();
  function onClick() {
    if (guest) {
      router.push(loginHref);
      return;
    }
    if (disabled || optimistic !== null) return;
    const next = !pressed;
    const done = () => toast(next ? '찜했습니다' : '찜을 해제했습니다', next ? 'ic-heart-fill' : 'ic-heart');
    if (!onToggle) {
      setLocal(next);
      done();
      return;
    }
    setOptimistic(next);
    void onToggle(next)
      .catch(() => false as const)
      .then((r) => {
        setOptimistic(null);
        if (r === true) {
          setLocal(next);
          done();
        } else toast(typeof r === 'string' && r ? r : '찜을 바꾸지 못했습니다. 잠시 뒤 다시 해 주세요', 'ic-heart');
      });
  }
  const blocked = disabled && !guest ? 'true' : undefined;
  const icon = (
    <i className={`ic ${pressed ? 'ic-heart-fill' : 'ic-heart'}`} aria-hidden="true" style={pressed ? { color: 'var(--danger)' } : undefined} />
  );
  if (variant === 'icon') {
    return (
      <button className={['icon-btn icon-btn-outline', className ?? ''].join(' ').trim()} type="button" aria-pressed={pressed} aria-disabled={blocked} aria-label="찜하기" onClick={onClick}>
        {icon}
      </button>
    );
  }
  return (
    <button className={['btn btn-outline btn-sm', className ?? ''].join(' ').trim()} type="button" aria-pressed={pressed} aria-disabled={blocked} onClick={onClick}>
      {icon}찜하기
    </button>
  );
}
