'use client';
// 문의하기 입력(보드 SCR-056 '문의하기'~'하루 한도', d5 §5.30 상태 표). 유형 12개, '외부 되팔이 게시물 신고'를 고르면 내용 칸 위에 안내(ADR-0173 결정 9).
// - 접수를 누르면 화면에서 먼저 검사하고, 틀리면 위쪽 오류 요약(CMP-012) + 첫 오류 칸으로 초점.
// - 내용에 계좌번호처럼 보이는 숫자열이 있으면 확인 창 "계좌번호는 적지 않아도 됩니다. 지우고 보낼까요?"
// - 접수 중에는 버튼을 바로 막고 aria-busy(중복 제출 방지). 접수되면 따로 완료 화면 없이 막 접수된 문의 상세로 간다(토스트는 상세가 띄운다).
// - 입력은 화면에만 둔다. 브라우저 저장소에 남기지 않는다(asvs 14.3.3). 퍼블리싱에서는 서버로 보내지 않고 대표 문의 상세로 옮긴다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FormErrorSummary } from '@peaket/ds/FormErrorSummary';
import { Select } from '@peaket/ds/Select';
import { TextArea } from '@peaket/ds/TextArea';
import { TextField } from '@peaket/ds/TextField';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { DEMO_INQUIRY_ID, INQUIRY_ORDER_OPTIONS, INQUIRY_TYPES, inquiryHref, inquiryTypeNotice, type InquiryType } from '@/entities/inquiry';
import type { Scr056NewState } from '@/shared/config/screens.discovery';
import { findAccountNumbers, maskAccountNumbers } from '../model/account';
import { BODY_MAX, initialDraft, validateDraft, type InquiryDraft, type InquiryErrors } from '../model/form';

const FIELD_IDS = { type: 'q-type', title: 'q-title', body: 'q-body' } as const;

export function InquiryForm({ state }: { state: Scr056NewState }) {
  const router = useRouter();
  const [draft, setDraft] = useState<InquiryDraft>(() => initialDraft(state));
  const [errors, setErrors] = useState<InquiryErrors>(() => (state === '문의 입력 오류' ? validateDraft(initialDraft(state)) : {}));
  const [submitCount, setSubmitCount] = useState(0);
  const [acctOpen, setAcctOpen] = useState(state === '계좌번호 확인 창');
  const [busy, setBusy] = useState(state === '접수 중');
  const [failed, setFailed] = useState(state === '접수 실패');
  const limited = state === '하루 한도';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const set = (k: keyof InquiryDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const send = (body: string) => {
    setDraft((d) => ({ ...d, body }));
    setAcctOpen(false);
    setFailed(false);
    setBusy(true);
    // 퍼블리싱: 접수 응답(201) 대신 잠시 뒤 대표 문의 상세로 간다. submitted=1이면 상세가 <접수됨>과 토스트를 보인다
    timer.current = setTimeout(() => router.push(`${inquiryHref(DEMO_INQUIRY_ID)}?submitted=1`), 900);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || limited) return;
    const next = validateDraft(draft);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      setSubmitCount((n) => n + 1);
      return;
    }
    if (findAccountNumbers(draft.body).length > 0) {
      setAcctOpen(true);
      return;
    }
    send(draft.body);
  };

  const typeNotice = inquiryTypeNotice(draft.type as InquiryType | '');
  const summary = (['type', 'title', 'body'] as const)
    .filter((k) => errors[k])
    .map((k) => ({ fieldId: FIELD_IDS[k], message: errors[k] }));

  return (
    <>
      {failed ? (
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">접수하지 못했습니다. 입력한 내용은 그대로 있습니다. 다시 시도해 주세요</div>
        </div>
      ) : null}
      {limited ? (
        <div className="banner banner-warning" role="alert" id="q-limit">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body col" style={{ gap: 6 }}>
            오늘은 더 접수할 수 없습니다. 급한 일이면 내 문의 내역의 진행 중인 문의에 추가로 적어 주세요
            <Link className="link-more" href="/help/inquiries" style={{ alignSelf: 'flex-start' }}>
              내 문의 내역
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          </div>
        </div>
      ) : null}
      {summary.length > 0 ? <FormErrorSummary key={submitCount} errors={summary} focusFirst={submitCount > 0} /> : null}

      <form className="col gap-5 md:gap-[22px]" aria-label="문의 내용" noValidate onSubmit={onSubmit}>
        <div className="col gap-5 md:grid md:grid-cols-2 md:items-start md:gap-4 lg:flex lg:flex-col lg:gap-[22px]">
          <Select
            id={FIELD_IDS.type}
            label="문의 유형"
            requiredMark
            placeholder="골라 주세요"
            options={INQUIRY_TYPES.map((t) => ({ value: t, label: t }))}
            value={draft.type}
            onChange={(e) => set('type')(e.target.value)}
            error={errors.type}
            className="lg:max-w-[360px]"
          />
          <Select
            id="q-order"
            label="관련 주문"
            optional
            options={INQUIRY_ORDER_OPTIONS}
            value={draft.orderId}
            onChange={(e) => set('orderId')(e.target.value)}
          />
        </div>
        <TextField
          id={FIELD_IDS.title}
          label="제목"
          requiredMark
          hint="5~50자"
          value={draft.title}
          onChange={(e) => set('title')(e.target.value)}
          error={errors.title}
        />
        {/* 고른 유형의 안내(외부 되팔이 게시물 신고: 공개 게시물만, 접수만 확인, d5 §5.30, ADR-0173 결정 9). 내용 칸 위 */}
        {typeNotice ? (
          <div className="banner banner-info" role="note" id="q-type-note">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">{typeNotice}</div>
          </div>
        ) : null}
        <TextArea
          id={FIELD_IDS.body}
          label="내용"
          requiredMark
          hint="건강 정보 같은 민감한 내용과 계좌번호는 적지 않아도 됩니다. 필요하면 담당자가 따로 확인합니다."
          maxLength={BODY_MAX}
          value={draft.body}
          onChange={(e) => set('body')(e.target.value)}
          error={errors.body}
          className="min-h-[168px] md:min-h-[200px]"
        />
        <div className="banner banner-info">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">
            답변은 &lsquo;내 문의 내역&rsquo;과 알림으로 알려 드립니다. 첨부 파일은 받지 않습니다. 증빙이 필요하면 담당자가 화면으로 확인하고 사본은 저장하지 않습니다.
          </div>
        </div>
        <section aria-label="개인정보 처리 안내">
          <p className="t-xs muted">
            문의를 처리하려고 문의 내용, 계정 정보(닉네임·계정 이메일)와 고른 주문 정보를 씁니다. 문의 기록은 소비자 불만·분쟁 처리 기록으로 처리가 끝나고 3년 동안 보관한 뒤 지웁니다(전자상거래법 시행령 §6①4호).
          </p>
        </section>
        {/* 휴대폰: 접수(위)·돌아가기(아래) 꽉 찬 버튼. 태블릿: 돌아가기 1 : 접수 1.6. 데스크톱: 오른쪽 정렬 한 줄 */}
        <div className="col gap-2 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] md:gap-3 lg:flex lg:flex-row lg:justify-end">
          <button
            className="btn btn-primary btn-lg btn-block md:order-2 lg:w-auto lg:min-w-[220px]"
            type="submit"
            aria-busy={busy ? true : undefined}
            aria-disabled={busy || limited ? true : undefined}
            aria-describedby={limited ? 'q-limit' : undefined}
          >
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                접수하는 중
              </>
            ) : (
              '문의를 접수합니다'
            )}
          </button>
          <Link className="btn btn-outline btn-lg btn-block md:order-1 lg:w-auto" href="/help">
            접수하지 않고 돌아가기
          </Link>
        </div>
      </form>

      <WebShellModal
        open={acctOpen}
        onClose={() => setAcctOpen(false)}
        title="계좌번호는 적지 않아도 됩니다. 지우고 보낼까요?"
        describedBy="ac-d"
        actions={
          <>
            <button className={webModalButtonClass('primary')} type="button" onClick={() => send(maskAccountNumbers(draft.body))}>
              지우고 보내기
            </button>
            <button className={webModalButtonClass('outline')} type="button" onClick={() => send(draft.body)}>
              그대로 보내기
            </button>
          </>
        }
      >
        <p className="t-sm muted md:text-md" id="ac-d">
          지우고 보내면 내용의 계좌번호를 &lsquo;(계좌번호 지움)&rsquo;으로 바꿔 보냅니다.
        </p>
      </WebShellModal>
    </>
  );
}
