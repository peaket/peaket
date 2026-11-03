'use client';
// SCR-014 상호작용: [양도 요청 보내기] → 소셜 재인증 시트(CMP-064 fan-social) → 양도 요청 확인 시트 → '요청 보냄' 상태, 재인증 만료 시트.
// 시트 마크업은 보드 SCR-014-m의 .scrim.bottom + .sheet 그대로다(ds Dialog auto: 휴대폰은 시트, md 이상은 가운데 대화상자).
// 실제 재인증·요청 API는 붙이지 않는다(퍼블리싱). 다음 상태로는 ?state= 주소를 바꿔 넘어간다.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@peaket/ds/Button';
import { Dialog } from '@peaket/ds/Dialog';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { previewHref } from '@peaket/ds/Preview';
import type { TransferSheet } from '../model/view';

export interface SendSectionProps {
  initialSheet: TransferSheet | null;
  /** 이 화면 경로(검색 문자열 없이) */
  path: string;
  /** 남길 검색 값(theme) */
  keep: Record<string, string | undefined>;
  seat: string;
  recipient: string;
  title: string;
  when: string;
  deadline: string;
}

/** ⑤ '보내기 전에 확인할 것' + [양도 요청 보내기] + 시트 셋 */
export function SendSection({ initialSheet, path, keep, seat, recipient, title, when, deadline }: SendSectionProps) {
  const router = useRouter();
  const [sheet, setSheet] = useState<TransferSheet | null>(initialSheet);
  const close = () => setSheet(null);
  const reauthed = () => setSheet('confirm');

  return (
    <section className="col gap-3" aria-labelledby="h-cf">
      <h2 className="t-md fw-b lg:text-lg" id="h-cf">
        보내기 전에 확인할 것
      </h2>
      <div className="card-flat col gap-2 px-4 py-3.5 lg:px-[18px] lg:py-4">
        <p className="t-sm" id="cf-note">
          받는 분이 수락하면 넘어갑니다. 수락 기한은 48시간과 양도 마감 중 이른 때입니다. 요청 중에는 예매를 취소할 수 없습니다
        </p>
        <p className="t-xs muted row gap-1.5">
          <i className="ic ic-shield ic-14" aria-hidden="true" />
          보내기 전에 카카오로 다시 로그인합니다
        </p>
      </div>
      <div className="row lg:justify-end">
        <Button size="lg" className="w-full lg:w-auto lg:min-w-[240px]" aria-describedby="cf-note" aria-haspopup="dialog" onClick={() => setSheet('reauth')}>
          양도 요청 보내기
        </Button>
      </div>

      <Dialog
        open={sheet === 'reauth'}
        onClose={close}
        layout="auto"
        icon="shield"
        iconTone="primary"
        title="다시 로그인하고 계속"
        description="양도는 되돌리기 어려운 작업이라 로그인한 분이 맞는지 한 번 더 확인합니다. 지금 로그인한 카카오 계정으로 다시 로그인해 주세요."
        actions={
          <>
            <Button variant="kakao" size="lg" block onClick={reauthed}>
              카카오로 다시 로그인하고 계속
            </Button>
            <Button variant="ghost" block onClick={close}>
              닫기
            </Button>
          </>
        }
      >
        <p className="t-sm muted">다시 로그인한 뒤 5분 안에 양도 요청을 보내야 합니다.</p>
      </Dialog>

      <Dialog
        open={sheet === 'confirm'}
        onClose={close}
        layout="auto"
        title="양도 요청 확인"
        describedBy="dc-d"
        actions={
          <>
            <Button
              size="lg"
              block
              style={{ whiteSpace: 'normal', height: 'auto', minHeight: 52, padding: '12px 16px' }}
              onClick={() => router.push(previewHref(path, '요청 보냄', keep), { scroll: false })}
            >
              {seat}을 {recipient}님에게 양도 요청합니다
            </Button>
            <Button variant="ghost" block onClick={close}>
              닫기
            </Button>
          </>
        }
      >
        <dl className="kv" id="dc-d">
          <dt>공연</dt>
          <dd>{title}</dd>
          <dt>일시</dt>
          <dd>{when}</dd>
          <dt>좌석</dt>
          <dd>{seat}</dd>
          <dt>받는 분</dt>
          <dd>{recipient}</dd>
          <dt>수락 기한</dt>
          <dd>{deadline}</dd>
        </dl>
        <p className="t-sm muted">받는 분이 수락하기 전까지는 요청을 철회할 수 있습니다. 요청 중에는 예매를 취소할 수 없습니다.</p>
        <p className="t-xs tx-success row gap-1.5">
          <i className="ic ic-check-circle ic-16" aria-hidden="true" />
          카카오로 다시 로그인했습니다
        </p>
      </Dialog>

      <Dialog
        open={sheet === 'expired'}
        onClose={close}
        layout="auto"
        title="다시 로그인해 주세요"
        describedBy="ex-d"
        actions={
          <>
            <Button variant="kakao" size="lg" block onClick={reauthed}>
              카카오로 다시 로그인하고 계속
            </Button>
            <Button variant="ghost" block onClick={close}>
              닫기
            </Button>
          </>
        }
      >
        <NoticeBanner tone="danger" role="alert">
          다시 로그인한 지 5분이 지났습니다. 다시 로그인해 주세요
        </NoticeBanner>
        <p className="t-sm muted" id="ex-d">
          양도 요청은 아직 보내지 않았습니다. 다시 로그인하면 이어서 보낼 수 있습니다.
        </p>
      </Dialog>
    </section>
  );
}

/** ⑥ 진행 중인 요청의 [요청 철회]. 철회하면 티켓 상세(SCR-013)로 돌아간다(d5 §5.14 나감) */
export function WithdrawButton({ seat, recipient, backHref }: { seat: string; recipient: string; backHref: string }) {
  const router = useRouter();
  return (
    <>
      <Button variant="outline" block icon="undo" aria-label={`${seat} 양도 요청 철회`} aria-describedby="wd-note" onClick={() => router.push(backHref)}>
        요청 철회
      </Button>
      <p className="t-xs muted" id="wd-note">
        {recipient} 님이 수락하기 전까지 철회할 수 있습니다. 요청 중에는 예매를 취소할 수 없습니다.
      </p>
    </>
  );
}
