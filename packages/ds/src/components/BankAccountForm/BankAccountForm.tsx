'use client';
// CMP-062 BankAccountForm(환불·배상·정산 계좌). 정본: d2 CMP-062, d5 §5.25·§5.34, 캔버스 보드 SCR-043·SCR-060의 입력 폼.
// 보드 마크업: 위에 .banner.banner-info(자물쇠, '계좌번호는 저장하지 않고 …에만 씁니다') → <form class="col" aria-label>
//   (오류면 .error-summary) → 은행 select(.input-group) → 계좌번호(inputmode numeric) → 예금주 → (재인증 안내 한 줄) → 제출 버튼.
// - 세 칸 모두 autocomplete="off"(d2 CMP-062). 오류는 칸에 aria-describedby로 잇고, 요약의 링크는 그 칸으로 간다.
// - 저장하지 않고 요청에 바로 넘긴다는 안내(POL-014·POL-039)는 notice로 받는다. 클라이언트 부품이다(서버 페이지는 onSubmit 없이 직렬화되는 값만 넘긴다).
// - layout 'split'은 태블릿·데스크톱(md 768 이상)에서 은행·계좌번호를 한 줄에 1:2로 둔다(SCR-043·060 태블릿·데스크톱 보드). 기본 'stack'은 늘 한 칸씩.
import type { FormEvent, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';
import { FormErrorSummary } from '../FormErrorSummary/FormErrorSummary';
import { Select, type SelectOption } from '../Select/Select';
import { TextField } from '../TextField/TextField';

export interface BankAccountValues {
  bank?: string;
  account?: string;
  holder?: string;
}

export interface BankAccountFormProps {
  /** 칸 id 앞부분(예: 'rf' → rf-bank·rf-acct·rf-name). 한 화면에 폼이 둘이면 달리 준다 */
  idPrefix: string;
  /** refund(환불) · compensation(배상) · payout(정산) */
  purpose?: 'refund' | 'compensation' | 'payout';
  /** 폼 이름(aria-label, 예: '환불받을 계좌') */
  label: string;
  /** 'stack'(기본, 칸을 위아래로) · 'split'(md 이상에서 은행 1 : 계좌번호 2 한 줄) */
  layout?: 'stack' | 'split';
  /** 폼 위 안내 띠 글(예: '계좌번호는 저장하지 않고 환불 요청에만 씁니다'). 없으면 띠를 그리지 않는다 */
  notice?: ReactNode;
  /** 은행 목록 */
  banks: readonly SelectOption[];
  /** 은행 고르기 전 안내(기본 '은행을 고르세요') */
  bankPlaceholder?: string;
  defaultValues?: BankAccountValues;
  /** 칸별 오류 글 */
  errors?: { bank?: ReactNode; account?: ReactNode; holder?: ReactNode };
  /** 오류 요약 제목(예: '환급을 요청하지 못했습니다'). 오류가 있을 때만 그린다 */
  errorTitle?: ReactNode;
  /** 오류 요약 항목 글(칸 이름: 오류). 없으면 칸 오류 글을 그대로 쓴다 */
  errorSummary?: { bank?: ReactNode; account?: ReactNode; holder?: ReactNode };
  /** 제출 버튼 위 한 줄 안내(재인증 안내 등). 버튼의 aria-describedby로 잇는다 */
  submitHint?: ReactNode;
  submitLabel: string;
  /** 요청 중(버튼 스피너·aria-busy, 낭독용 상태 글) */
  submitting?: boolean;
  submittingLabel?: string;
  /** 요청 중 낭독 글(role="status") */
  submittingStatus?: string;
  /** 버튼 밑(폼 안) 덧붙임 */
  footer?: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  className?: string;
}

export function BankAccountForm({
  idPrefix,
  purpose = 'refund',
  label,
  layout = 'stack',
  notice,
  banks,
  bankPlaceholder = '은행을 고르세요',
  defaultValues,
  errors,
  errorTitle,
  errorSummary,
  submitHint,
  submitLabel,
  submitting = false,
  submittingLabel,
  submittingStatus,
  footer,
  onSubmit,
  className,
}: BankAccountFormProps) {
  const ids = { bank: `${idPrefix}-bank`, account: `${idPrefix}-acct`, holder: `${idPrefix}-name` };
  const hintId = `${idPrefix}-submit-hint`;
  const summary = (['bank', 'account', 'holder'] as const)
    .filter((k) => errors?.[k])
    .map((k) => ({ fieldId: ids[k], message: errorSummary?.[k] ?? errors?.[k] }));

  const bankField = (
    <Select
      id={ids.bank}
      label="은행"
      requiredMark
      autoComplete="off"
      placeholder={defaultValues?.bank ? undefined : bankPlaceholder}
      options={banks}
      defaultValue={defaultValues?.bank ?? ''}
      error={errors?.bank}
    />
  );
  const accountField = (
    <TextField
      id={ids.account}
      label="계좌번호"
      requiredMark
      type="text"
      inputMode="numeric"
      autoComplete="off"
      defaultValue={defaultValues?.account}
      error={errors?.account}
    />
  );

  return (
    <div className={cx('col', className)} style={{ gap: 20 }} data-purpose={purpose}>
      {notice ? (
        <div className="banner banner-info">
          <Icon name="lock" />
          <div className="banner-body">{notice}</div>
        </div>
      ) : null}
      <form
        className="col"
        style={{ gap: 16 }}
        aria-label={label}
        aria-busy={submitting || undefined}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.(e);
        }}
      >
        {summary.length > 0 ? <FormErrorSummary title={errorTitle} errors={summary} /> : null}
        {layout === 'split' ? (
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-3">
            {bankField}
            {accountField}
          </div>
        ) : (
          <>
            {bankField}
            {accountField}
          </>
        )}
        <TextField
          id={ids.holder}
          label="예금주"
          requiredMark
          type="text"
          autoComplete="off"
          defaultValue={defaultValues?.holder}
          error={errors?.holder}
        />
        {submitHint && !submitting ? (
          <p className="t-xs muted row" style={{ gap: 6 }} id={hintId}>
            <Icon name="shield" size={14} />
            {submitHint}
          </p>
        ) : null}
        {submitting ? (
          <>
            <button className="btn btn-primary btn-lg btn-block" type="button" aria-busy="true">
              <span className="spinner" aria-hidden="true" />
              {submittingLabel ?? submitLabel}
            </button>
            {submittingStatus ? (
              <p className="sr-only" role="status">
                {submittingStatus}
              </p>
            ) : null}
          </>
        ) : (
          <button className="btn btn-primary btn-lg btn-block" type="submit" aria-describedby={submitHint ? hintId : undefined}>
            {submitLabel}
          </button>
        )}
        {footer}
      </form>
    </div>
  );
}
