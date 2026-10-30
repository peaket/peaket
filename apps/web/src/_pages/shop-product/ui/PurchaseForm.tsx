'use client';
// 상품 상세의 고르기 칸(보드 SCR-015 isDetail): 옵션 ▾ · 수량 [− 1 +](계정당 최대 n개) · 수령 방식(필수).
// 데스크톱(lg)은 옵션과 수량을 두 칸에 나란히 둔다. 부가 상품은 수령 방식이 없다(현장·월렛 이용권, 택배 없음).
import { RadioGroup, type RadioOption } from '@peaket/ds/RadioGroup';
import { Select } from '@peaket/ds/Select';
import { useState } from 'react';
import { QuantityStepper } from '@/entities/cart';
import type { Product } from '@/entities/product';

export interface PurchaseFormProps {
  product: Product;
  pickupOptions: readonly RadioOption[];
}

export function PurchaseForm({ product: p, pickupOptions }: PurchaseFormProps) {
  const [option, setOption] = useState(p.options?.defaultValue ?? '');
  const [qty, setQty] = useState(1);
  return (
    <>
      <div className="col gap-5 lg:grid lg:grid-cols-2 lg:items-start">
        {p.options ? (
          <Select
            id="opt-size"
            label={p.options.label}
            requiredMark
            value={option}
            onChange={(e) => setOption(e.target.value)}
            options={p.options.values.map((v) => ({ value: v, label: v }))}
          />
        ) : null}
        <div className="field">
          <span className="label" id="qty-l">
            수량
          </span>
          <QuantityStepper labelledBy="qty-l" describedBy="qty-h" value={qty} max={p.perAccountLimit} onChange={setQty} />
          <span className="hint" id="qty-h">
            계정당 최대 {p.perAccountLimit}개까지 구매할 수 있습니다
          </span>
        </div>
      </div>
      {pickupOptions.length > 0 ? (
        <RadioGroup name="pick-a" legend="수령 방식" requiredMark options={pickupOptions} defaultValue={pickupOptions[0]?.value} />
      ) : null}
    </>
  );
}
