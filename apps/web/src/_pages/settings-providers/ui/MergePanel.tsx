'use client';
// SCR-040 ④~⑥ 계정 합치기 카드(ds MergeSummary, CMP-056)와 재인증 뒤 확인 창(CMP-020 위험 확인, 보드 SCR-040-d '병합 확인').
// [카카오로 다시 로그인하고 계속]은 재인증(CMP-064)을 흉내 내 바로 확인 창을 연다. 확인 창은 휴대폰에서 아래 시트, md 이상에서 대화상자.
// 확인하면 이 자리에서 '병합 중'(202)으로 바뀌고, [합치지 않고 닫기]·[닫기]는 카드를 치운다.
// 보드는 확인 창의 '다시 로그인했습니다' 줄이 제목 위에 있으나, ds Dialog는 제목을 먼저 그려 제목 바로 아래에 둔다.
import { useId, useRef, useState } from 'react';
import { Dialog } from '@peaket/ds/Dialog';
import { MergeSummary, type MergeSummaryStatus } from '@peaket/ds/MergeSummary';
import type { MergeContent } from '../model/content';

export interface MergePanelProps {
  initialStatus: MergeSummaryStatus;
  confirmOpen: boolean;
  content: MergeContent;
  provider: 'kakao' | 'naver' | 'google';
}

export function MergePanel({ initialStatus, confirmOpen, content, provider }: MergePanelProps) {
  const [status, setStatus] = useState(initialStatus);
  const [open, setOpen] = useState(confirmOpen);
  const [dismissed, setDismissed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const movesId = `${useId()}-mc-mv`;
  const { continueLabel, confirm, ...summary } = content;

  if (dismissed) return null;

  return (
    <>
      <MergeSummary
        {...summary}
        status={status}
        continueAction={{ label: continueLabel, provider, onClick: () => setOpen(true) }}
        onDismiss={() => setDismissed(true)}
        className="mx-4 mt-7 md:mx-0 md:mt-0"
      />

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={confirm.title}
        layout="auto"
        role="alertdialog"
        maxWidth={480}
        initialFocus={cancelRef}
      >
        <p className="row t-sm tx-success" style={{ gap: 6 }}>
          <i className="ic ic-check-circle ic-16" aria-hidden="true" />
          {confirm.reauthed}
        </p>
        <dl className="kv">
          <dt>남는 계정(대표)</dt>
          <dd>{summary.survivor}</dd>
          <dt>합쳐지는 계정</dt>
          <dd>{summary.absorbed}</dd>
        </dl>
        <div className="card-flat col" style={{ gap: 8, padding: '14px 16px' }}>
          <h3 className="t-sm fw-b" id={movesId}>
            옮겨 오는 것
          </h3>
          <ul className="t-sm" aria-labelledby={movesId} style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '6px 20px' }}>
            {summary.moves.map((m, i) => (
              <li key={i} className="row between">
                <span className="muted">{m.label}</span>
                <span className="num fw-b">{m.value}</span>
              </li>
            ))}
          </ul>
          {summary.movesNote ? <p className="t-xs muted">{summary.movesNote}</p> : null}
        </div>
        <p className="t-sm">{confirm.note}</p>
        <div className="col" style={{ gap: 8 }}>
          <button
            className="btn btn-danger btn-lg btn-block"
            type="button"
            onClick={() => {
              setOpen(false);
              setStatus('merging');
            }}
          >
            {confirm.confirmLabel}
          </button>
          <button ref={cancelRef} className="btn btn-ghost btn-block" type="button" onClick={() => setOpen(false)}>
            {confirm.cancelLabel}
          </button>
        </div>
      </Dialog>
    </>
  );
}
