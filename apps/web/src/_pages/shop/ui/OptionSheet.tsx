'use client';
// 옵션 시트 "옵션 고르기"(d5 §5.15, ADR-0066): 옵션 있는 상품의 카드 장바구니 버튼이 연다.
// 휴대폰(768 미만)은 바텀 시트([[장바구니에 담기]] 위 · [닫기] 아래), 태블릿·데스크톱은 작은 대화상자(오른쪽 정렬 [닫기] [장바구니에 담기]).
// 시트·대화상자 전환은 ds Dialog layout="auto"가 하고, 버튼 배치는 같은 768 중단점의 md: 유틸로 바꾼다.
import { useState } from 'react';
import { Dialog } from '@peaket/ds/Dialog';
import { Select } from '@peaket/ds/Select';
import { QuantityStepper } from '@/entities/cart';
import { won, type Product } from '@/entities/product';

export interface OptionSheetProps {
  product: Product | null;
  onClose: () => void;
  onAdd: (product: Product, option: string, quantity: number) => void;
  onLimit: (limit: number) => void;
}

export function OptionSheet({ product, onClose, onAdd, onLimit }: OptionSheetProps) {
  return product ? <OptionSheetBody key={product.id} product={product} onClose={onClose} onAdd={onAdd} onLimit={onLimit} /> : null;
}

function OptionSheetBody({ product: p, onClose, onAdd, onLimit }: OptionSheetProps & { product: Product }) {
  const [option, setOption] = useState(p.options?.defaultValue ?? '');
  const [qty, setQty] = useState(1);
  const add = () => onAdd(p, option, qty);
  return (
    <Dialog
      open
      onClose={onClose}
      layout="auto"
      maxWidth={400}
      title="옵션 고르기"
      description={<span className="muted">{`${p.title} · ${won(p.price)}`}</span>}
      actions={
        <>
          <button className="btn btn-primary btn-lg btn-block md:hidden" type="button" onClick={add}>
            장바구니에 담기
          </button>
          <button className="btn btn-ghost btn-block md:hidden" type="button" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-ghost hidden md:inline-flex" type="button" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-primary hidden md:inline-flex" type="button" onClick={add}>
            장바구니에 담기
          </button>
        </>
      }
    >
      {p.options ? (
        <Select
          id="os-size"
          label={p.options.label}
          requiredMark
          value={option}
          onChange={(e) => setOption(e.target.value)}
          options={p.options.values.map((v) => ({ value: v, label: v }))}
        />
      ) : null}
      <div className="field">
        <span className="label" id="os-qty-l">
          수량
        </span>
        <QuantityStepper labelledBy="os-qty-l" describedBy="os-qty-h" value={qty} max={p.perAccountLimit} onChange={setQty} onLimit={() => onLimit(p.perAccountLimit)} />
        <span className="hint" id="os-qty-h">
          계정당 최대 {p.perAccountLimit}개까지 구매할 수 있습니다
        </span>
      </div>
    </Dialog>
  );
}
