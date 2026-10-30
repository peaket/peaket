'use client';
// SCR-043 배상금 받을 계좌 폼(CMP-062 BankAccountForm compensation)과 재인증 시트. [송금 요청]을 누르면 재인증 시트를 연다(d5 §5.25).
// 상태 '재인증 시트'·'재인증 만료'는 시트를 열린 채로 그린다. 은행 목록·입력해 둔 값은 합성 목업(entities/account)이다.
import { useState } from 'react';
import { BankAccountForm } from '@peaket/ds/BankAccountForm';
import { BANKS, SAMPLE_BANK_INPUT } from '@/entities/account';
import { ReauthSheet, type ReauthSheetKind } from './ReauthSheet';

export interface CompensationAccountFormProps {
  mode: 'input' | 'submitting' | 'error';
  initialSheet: ReauthSheetKind | null;
}

export function CompensationAccountForm({ mode, initialSheet }: CompensationAccountFormProps) {
  const [sheet, setSheet] = useState<ReauthSheetKind | null>(initialSheet);
  return (
    <>
      <BankAccountForm
        idPrefix="cp"
        purpose="compensation"
        layout="split"
        label="배상금 받을 계좌"
        notice="계좌번호는 저장하지 않고 송금에만 씁니다"
        banks={BANKS}
        defaultValues={mode === 'input' ? undefined : SAMPLE_BANK_INPUT}
        errors={mode === 'error' ? { account: '이 계좌로는 송금할 수 없습니다. 은행과 계좌번호를 확인해 다시 입력해 주세요' } : undefined}
        errorTitle="송금하지 못했습니다"
        errorSummary={{ account: '계좌번호: 이 계좌로는 송금할 수 없습니다' }}
        submitHint={mode === 'input' ? '송금을 요청하기 전에 카카오로 다시 로그인합니다' : undefined}
        submitLabel="송금 요청"
        submitting={mode === 'submitting'}
        submittingLabel="송금 요청 중"
        submittingStatus="송금을 요청하고 있습니다"
        onSubmit={() => setSheet('reauth')}
      />
      <ReauthSheet open={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
