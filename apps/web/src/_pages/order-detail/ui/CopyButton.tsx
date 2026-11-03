'use client';
// 번호 복사(CMP-003 IconButton 복사)와 가상계좌 번호 복사 버튼. 결과는 토스트로 알린다(d3 SCR-055: 복사 버튼 이름에 번호를 넣는다).
import { useToast } from '@/shared/ui/toast';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function useCopy(text: string, done: string) {
  const toast = useToast();
  return async () => toast((await copy(text)) ? done : '복사하지 못했습니다', 'ic-copy');
}

/** 아이콘 버튼(예매번호·주문번호 카드 오른쪽) */
export function CopyIconButton({ text, label, done }: { text: string; label: string; done: string }) {
  const onClick = useCopy(text, done);
  return (
    <button className="icon-btn" type="button" aria-label={label} onClick={onClick}>
      <i className="ic ic-copy" aria-hidden="true" />
    </button>
  );
}

/** 글자 버튼(휴대폰은 꽉 찬 폭, 태블릿·데스크톱은 왼쪽 정렬 보통 폭) */
export function CopyBlockButton({ text, label, name, done }: { text: string; label: string; name: string; done: string }) {
  const onClick = useCopy(text, done);
  return (
    <button className="btn btn-outline btn-block md:inline-flex md:w-auto md:self-start" type="button" aria-label={name} onClick={onClick}>
      <i className="ic ic-copy" aria-hidden="true" />
      {label}
    </button>
  );
}
