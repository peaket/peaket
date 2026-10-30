'use client';
// SCR-012 결제 결과의 움직이는 부분: 복사 버튼(예매번호·가상계좌, 결과는 토스트)과 '홈 화면에 추가' 방법 대화상자.
import { useState } from 'react';
import { Dialog } from '@peaket/ds/Dialog';
import { useToast } from '@/shared/ui/toast';

/** 보이는 글은 짧게('복사'), 낭독 이름은 무엇을 복사하는지(aria-label) */
export function CopyButton({
  text,
  label,
  ariaLabel,
  done,
  className = 'btn btn-outline btn-sm',
}: {
  text: string;
  label: string;
  ariaLabel: string;
  done: string;
  className?: string;
}) {
  const toast = useToast();
  return (
    <button
      className={className}
      type="button"
      aria-label={ariaLabel}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast(done, 'ic-copy');
        } catch {
          toast('복사하지 못했습니다', 'ic-copy');
        }
      }}
    >
      <i className="ic ic-copy" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * ⑤ 홈 화면에 추가 안내의 [방법 보기](CMP-068 pwa-install 자리). 추천안: account 담당의 NotifyPermissionSheet가 생기기 전까지
 * 기기별 추가 방법 두 줄만 대화상자로 보인다(휴대폰은 아래 시트).
 */
export function InstallGuideButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-text" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        방법 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        layout="auto"
        icon="phone"
        iconTone="primary"
        title="홈 화면에 추가하는 방법"
        description="추가한 앱에서 티켓을 한 번 열어 두면, 공연장에서 인터넷이 없어도 티켓이 열립니다"
        actions={
          <button className="btn btn-primary btn-lg w-full md:w-auto" type="button" onClick={() => setOpen(false)}>
            확인
          </button>
        }
      >
        <ol className="col t-sm" style={{ gap: 8, paddingLeft: 18, listStyle: 'decimal' }}>
          <li>아이폰: 사파리 아래쪽 공유 버튼을 누르고 &lsquo;홈 화면에 추가&rsquo;를 고릅니다</li>
          <li>안드로이드: 크롬 오른쪽 위 메뉴에서 &lsquo;홈 화면에 추가&rsquo; 또는 &lsquo;앱 설치&rsquo;를 고릅니다</li>
        </ol>
      </Dialog>
    </>
  );
}
