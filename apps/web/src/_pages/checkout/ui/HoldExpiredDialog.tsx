'use client';
// SCR-011 홀드 만료 대화상자. 만료 때만 보여서 실제 결제 화면은 필요할 때 싣는다(CheckoutLive의 lazy, docs/frontend.md §5.8 '결제 화면' 첫 JS 180kB).
import Link from 'next/link';
import { useState } from 'react';
import { Dialog } from '@peaket/ds/Dialog';

/** 홀드 만료(결제창 열기 전): 휴대폰은 아래 시트, 태블릿·데스크톱은 가운데 대화상자 */
export function HoldExpiredDialog({ seatsHref }: { seatsHref: string }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      layout="auto"
      icon="clock"
      title="홀드 시간이 끝났습니다"
      description="요금은 청구되지 않습니다"
      actions={
        <Link className="btn btn-primary btn-lg w-full md:w-auto" href={seatsHref}>
          좌석 다시 고르기
        </Link>
      }
    />
  );
}
