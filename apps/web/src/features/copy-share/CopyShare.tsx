'use client';
// 공유(Web Share API, 없으면 주소 복사)와 글 복사(공연장 주소 복사) 버튼(d5 §5.2 ⑫·⑮). 결과는 토스트로 알린다.
import { useToast } from '@/shared/ui/toast';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareButton({ title, variant = 'icon', className }: { title: string; variant?: 'icon' | 'outline'; className?: string }) {
  const toast = useToast();
  async function onClick() {
    const url = window.location.href.split('?')[0] ?? window.location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // 공유 창을 닫았거나 실패하면 주소 복사로 넘어간다
      }
    }
    toast((await copy(url)) ? '주소를 복사했습니다' : '주소를 복사하지 못했습니다', 'ic-link');
  }
  if (variant === 'icon') {
    return (
      <button className={['icon-btn icon-btn-outline', className ?? ''].join(' ').trim()} type="button" aria-label="공유하기" onClick={onClick}>
        <i className="ic ic-share" aria-hidden="true" />
      </button>
    );
  }
  return (
    <button className={['btn btn-outline btn-sm', className ?? ''].join(' ').trim()} type="button" onClick={onClick}>
      <i className="ic ic-share" aria-hidden="true" />
      공유하기
    </button>
  );
}

export function CopyTextButton({
  text,
  label,
  describedBy,
  done = '복사했습니다',
  className,
}: {
  text: string;
  label: string;
  describedBy?: string;
  done?: string;
  className?: string;
}) {
  const toast = useToast();
  return (
    <button
      className={['btn btn-outline btn-sm', className ?? ''].join(' ').trim()}
      type="button"
      aria-describedby={describedBy}
      onClick={async () => toast((await copy(text)) ? done : '복사하지 못했습니다', 'ic-copy')}
    >
      <i className="ic ic-copy" aria-hidden="true" />
      {label}
    </button>
  );
}
