'use client';
// 굿즈 주문 취소·반품(POL-016 §1.4, d5 §5.29 '굿즈 주문 취소·반품 화면', 보드 SCR-055 반품 요청·굿즈 주문 취소 확인).
// 휴대폰(768 미만)은 아래 시트(주 버튼이 위), 태블릿·데스크톱은 대화상자(주 버튼이 오른쪽 끝) — CMP-019 Dialog layout auto.
// 상태 미리보기에서는 defaultOpen으로 열린 채 그린다. 요청·취소 버튼은 아직 창만 닫는다(데이터 연결 단계에서 API를 붙인다).
import { useId, useRef, useState } from 'react';
import { Dialog } from '@peaket/ds/Dialog';
import { RadioGroup } from '@peaket/ds/RadioGroup';
import { TextField } from '@peaket/ds/TextField';
import { webModalButtonClass } from '@peaket/ds/WebShell';
import { formatWon } from '@/entities/production';

/** 여는 버튼: 휴대폰은 꽉 찬 폭, 태블릿·데스크톱은 왼쪽 정렬 보통 폭(보드 m·t·d) */
const TRIGGER = 'btn btn-outline btn-block md:inline-flex md:w-auto md:self-start';
/** 시트는 세로로 쌓고 첫 버튼이 위, 대화상자(.dialog-actions 안)는 한 줄에 첫 버튼이 오른쪽 끝 */
const ACTIONS = 'col gap-2 md:flex-row-reverse md:flex-wrap md:items-center';

export interface ReturnRequestProps {
  defaultOpen: boolean;
  /** 'LUMEN 공식 응원봉 · 1개 · 주문번호 2026102100056' */
  itemLine: string;
  price: number;
  /** 단순 변심 반품 배송비 */
  fee: number;
  /** 반품 주소(판매자) 줄 */
  returnTo: string;
  /** 반품 기한 줄의 id(여는 버튼 aria-describedby) */
  dueId: string;
}

export function ReturnRequest({ defaultOpen, itemLine, price, fee, returnTo, dueId }: ReturnRequestProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [why, setWhy] = useState('change');
  const ids = useId();
  const close = () => setOpen(false);
  const quote =
    why === 'change' ? `반품 배송비 ${formatWon(fee)}을 빼고 ${formatWon(price - fee)}을 환급합니다` : `배송비 없이 ${formatWon(price)}을 환급합니다`;
  return (
    <>
      <button className={TRIGGER} type="button" aria-haspopup="dialog" aria-describedby={dueId} onClick={() => setOpen(true)}>
        반품 요청
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="반품 요청"
        layout="auto"
        maxWidth={480}
        describedBy={`${ids}-d`}
        actions={
          <div className={ACTIONS}>
            <button className={webModalButtonClass('primary')} type="button" onClick={close}>
              반품을 요청합니다
            </button>
            <button className={webModalButtonClass('ghost')} type="button" onClick={close}>
              반품하지 않고 닫기
            </button>
          </div>
        }
      >
        <p className="t-sm muted" id={`${ids}-d`}>
          {itemLine}
        </p>
        <RadioGroup
          name={`${ids}-why`}
          legend="사유"
          requiredMark
          options={[
            { value: 'change', label: '단순 변심' },
            { value: 'defect', label: '상품 이상·설명과 다름' },
          ]}
          value={why}
          onValueChange={setWhy}
        />
        <div className="card-flat col" style={{ gap: 4, padding: '12px 14px' }} role="status">
          <span className="eyebrow">환급 예상</span>
          <p className="t-sm fw-b">{quote}</p>
        </div>
        <dl className="col" style={{ gap: 2 }}>
          <dt className="t-xs fw-b muted">반품 주소(판매자)</dt>
          <dd className="t-sm">{returnTo}</dd>
        </dl>
        <TextField id={`${ids}-inv`} label="반품 송장" optional />
      </Dialog>
    </>
  );
}

export interface OrderCancelProps {
  defaultOpen: boolean;
  itemLine: string;
  price: number;
  /** '발송 전이라' · '수령 전이라' · '입장 시작 전이라' */
  reason: string;
}

export function OrderCancel({ defaultOpen, itemLine, price, reason }: OrderCancelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const keepRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const close = () => setOpen(false);
  const won = formatWon(price);
  return (
    <>
      <button className={TRIGGER} type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        주문 취소
      </button>
      <Dialog
        open={open}
        onClose={close}
        title="주문 취소"
        role="alertdialog"
        layout="auto"
        maxWidth={480}
        describedBy={`${ids}-d`}
        initialFocus={keepRef}
        actions={
          <div className={ACTIONS}>
            <button className={webModalButtonClass('danger')} type="button" onClick={close}>
              주문을 취소하고 {won}을 환급받습니다
            </button>
            <button ref={keepRef} className={webModalButtonClass('ghost')} type="button" onClick={close}>
              취소하지 않고 닫기
            </button>
          </div>
        }
      >
        <p className="t-md" id={`${ids}-d`}>
          {reason} 바로 취소하고 {won}을 결제한 수단으로 환급합니다
        </p>
        <p className="t-sm muted">{itemLine}</p>
      </Dialog>
    </>
  );
}
