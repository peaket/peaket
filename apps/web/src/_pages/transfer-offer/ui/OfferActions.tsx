'use client';
// SCR-041 행동: [받기] [거절](수락 대기) · [이 휴대폰을 입장용으로 등록](받은 뒤). 실제 수락·키 등록 API는 붙이지 않는다(퍼블리싱).
// 받기 → '수락 완료' 상태, 거절 → 마이 티켓, 등록 → 티켓 상세(SCR-013). 입장 키는 이 등록 버튼으로만 만든다(POL-018).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@peaket/ds/Button';
import { previewHref } from '@peaket/ds/Preview';

export function AcceptButtons({ seat, path, keep }: { seat: string; path: string; keep: Record<string, string | undefined> }) {
  const router = useRouter();
  return (
    <div className="col gap-2.5">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2 md:gap-2.5 lg:flex lg:justify-end">
        <Button
          size="lg"
          className="lg:min-w-[200px]"
          aria-label={`${seat} 티켓 받기`}
          aria-describedby="payer-note"
          onClick={() => router.push(previewHref(path, '수락 완료', keep), { scroll: false })}
        >
          받기
        </Button>
        <Button variant="secondary" size="lg" className="lg:min-w-[120px]" aria-label={`${seat} 양도 요청 거절`} onClick={() => router.push('/my/tickets')}>
          거절
        </Button>
      </div>
      <p className="t-xs muted text-center lg:text-right">받은 뒤 입장할 휴대폰에서 등록해야 QR이 나옵니다</p>
    </div>
  );
}

export function RegisterDevice({ seat, ticketHref }: { seat: string; ticketHref: string }) {
  const router = useRouter();
  return (
    <div className="col gap-3">
      <Button size="lg" block aria-label={`${seat}, 이 휴대폰을 입장용으로 등록`} onClick={() => router.push(ticketHref)}>
        이 휴대폰을 입장용으로 등록
      </Button>
      <Link className="link-more self-center" href="/my/tickets">
        나중에 휴대폰에서 등록
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
      <p className="t-xs muted">
        입장용으로 등록해야 입장 QR이 만들어집니다. 입장 시작 24시간 전까지 등록하지 않으면 다시 알려 드립니다. 이 티켓은 결제한 분만 취소할 수 있고, 다시 양도할 수 없습니다.
      </p>
    </div>
  );
}
