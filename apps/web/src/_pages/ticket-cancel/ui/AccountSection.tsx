'use client';
// SCR-038 ⑦ 환불받을 계좌(재인증에서 돌아온 뒤 마지막 확인 안에서만 그린다, d5 §5.20 ⑤ → ⑦).
// 무거운 입력 부품(Select·TextField)과 은행 목록을 첫 묶음에서 빼려고 TicketCancelLive가 늦게 싣는다(frontend §5.8).
// 계좌는 이 화면 상태와 요청 본문에만 있고 저장소·주소·로그로 내보내지 않는다(POL-014).
import { Select } from '@peaket/ds/Select';
import { TextField } from '@peaket/ds/TextField';
import { REFUND_BANKS } from '@peaket/validation/refund-account';

export interface AccountDraft {
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

export function AccountSection({ account, error, onChange }: { account: AccountDraft; error: string | null; onChange: (next: AccountDraft) => void }) {
  return (
    <section className="col gap-3.5" aria-labelledby="h-account">
      <h3 className="t-sm fw-b" id="h-account">
        환불받을 계좌
      </h3>
      <Select
        id="tc-bank"
        label="은행"
        placeholder="은행을 고르세요"
        options={REFUND_BANKS.map((b) => ({ value: b.code, label: b.label }))}
        value={account.bankCode}
        onChange={(e) => onChange({ ...account, bankCode: e.target.value })}
      />
      <TextField
        id="tc-account"
        label="계좌번호"
        inputMode="numeric"
        autoComplete="off"
        placeholder="숫자와 하이픈"
        value={account.accountNumber}
        onChange={(e) => onChange({ ...account, accountNumber: e.target.value })}
        hint="계좌번호는 저장하지 않고 환불 요청에만 씁니다"
      />
      <TextField
        id="tc-holder"
        label="예금주"
        autoComplete="off"
        value={account.holderName}
        onChange={(e) => onChange({ ...account, holderName: e.target.value })}
        error={error ?? undefined}
      />
    </section>
  );
}
