'use client';
// SCR-005 ③ 선택 동의 '휴대폰 번호 수집'과 휴대폰 번호 칸(CMP-008). 동의에 체크해야 칸이 켜진다(보드: 처음엔 꺼진 칸 + 이유 글).
// 선택 동의는 필수 동의와 같은 묶음 체크로 켜지지 않는다(d5 §5.5, d1 §3 다크 패턴 금지).
import { useState } from 'react';
import { ConsentCheckbox } from '@peaket/ds/ConsentCheckbox';
import { PhoneField } from '@peaket/ds/PhoneField';

export function PhoneOptIn() {
  const [on, setOn] = useState(false);
  return (
    <>
      <ConsentCheckbox id="c-phone" requirement="optional" label="휴대폰 번호 수집" aria-controls="f-phone" checked={on} onCheckedChange={setOn} />
      <PhoneField
        id="f-phone"
        label="휴대폰 번호"
        optional
        disabled={!on}
        hint="휴대폰 번호 수집에 동의하면 입력할 수 있습니다"
        fieldClassName="pl-8"
      />
    </>
  );
}
