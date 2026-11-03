'use client';
// CMP-075 ReportDialog(d2 §2 CMP-075 행, d5 §5.16 신고 모달·신고 확인 모달, 보드 SCR-016 '신고'~'신고 보내는 중').
// - 신고 모달(report): 대상 상자 → 사유 8종(칩 모양 라디오, 휴대폰 1열·md 이상 2열, role="radiogroup") → 사유별 안내
//   (1·2번 정부 신고기관 바로가기, 4번 권리를 침해받은 본인인지·처리 결과 받을 곳, 5번 즉시 가림 경고) → 자세한 내용 0~500자
//   → 유의사항 6줄 → [신고 보내기]·[닫기]. 오류는 위쪽 오류 요약(CMP-012)과 묶음 아래 오류 글, 실패·429·404는 위쪽 배너.
// - 확인 모달(confirm): role="alertdialog". 대상·이유·자세한 내용 요약 → 다짐 글 → [신고합니다](보내는 중이면 aria-busy) · [다시 고치기].
// - 신고 모달은 후기 전체 모달 자리를, 확인 모달은 신고 모달 자리를 바꿔 연다(겹치지 않는다). 그 전환은 부르는 화면이 맡는다.
// - 입력은 화면에만 두고 브라우저 저장소에 남기지 않는다(부르는 화면이 draft를 들고 있다).
// 문구 정본: docs/design/d5 §5.16 '신고 모달 문구'. 기관 이름·주소는 d5 그대로다.
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { FormErrorSummary } from '../FormErrorSummary/FormErrorSummary';
import { ModalFrame } from './ModalFrame';

export type ReportReason = 'SCALPING' | 'MACRO' | 'ABUSE' | 'RIGHTS' | 'ILLEGAL_FILMING' | 'SPAM' | 'OFF_TOPIC' | 'OTHER';

/** 신고 사유 8종(d5 §5.16 그림 순서 1~8, 값은 API 사유 코드) */
export const REPORT_REASONS: readonly { value: ReportReason; label: string; hint?: string }[] = [
  { value: 'SCALPING', label: '암표·부정판매', hint: '웃돈을 받고 티켓을 팔거나 사겠다는 글' },
  { value: 'MACRO', label: '매크로·부정 예매 프로그램', hint: '자동 예매 프로그램을 팔거나 쓰라고 권하는 글' },
  { value: 'ABUSE', label: '욕설·비방·혐오 표현' },
  { value: 'RIGHTS', label: '개인정보 노출·명예훼손', hint: '연락처·얼굴·실명이 드러나거나, 사실이 아닌 내용으로 명예를 훼손하는 글' },
  { value: 'ILLEGAL_FILMING', label: '음란물·불법 촬영물' },
  { value: 'SPAM', label: '광고·도배' },
  { value: 'OFF_TOPIC', label: '공연과 관계없는 내용' },
  { value: 'OTHER', label: '기타' },
];

export function reportReasonLabel(reason: ReportReason): string {
  return REPORT_REASONS.find((r) => r.value === reason)?.label ?? '';
}

/** 온라인 암표신고센터(공연 및 스포츠 암표 통합 신고 누리집, 한국콘텐츠진흥원). 게시물 정보는 주소에 싣지 않는다 */
export const SCALPING_REPORT_CENTER_URL = 'https://www.culture.go.kr/singo/';

export type ReportNotifyChannel = 'APP' | 'EMAIL';

export interface ReportDraft {
  reason: ReportReason | null;
  detail: string;
  /** 4번 사유: 권리를 침해받은 본인인가 */
  rightsHolder: 'yes' | 'no' | null;
  /** 4번 본인 요청: 처리 결과를 받을 곳 */
  notify: ReportNotifyChannel | null;
}

export const EMPTY_REPORT_DRAFT: ReportDraft = { reason: null, detail: '', rightsHolder: null, notify: null };

export type ReportFieldError = 'reason' | 'rightsHolder' | 'notify' | 'detail';

const ERROR_TEXT: Record<ReportFieldError, string> = {
  reason: '신고하는 이유를 골라 주세요',
  rightsHolder: '권리를 침해받은 본인인지 골라 주세요',
  notify: '처리 결과를 받을 곳을 골라 주세요',
  detail: '자세한 내용을 적어 주세요',
};

/** 4번에서 본인이라고 고르거나 8번(기타)이면 자세한 내용이 필수다 */
export function reportDetailRequired(draft: ReportDraft): boolean {
  return draft.reason === 'OTHER' || (draft.reason === 'RIGHTS' && draft.rightsHolder === 'yes');
}

/** 보내기 전 검사. 오류 칸 목록(화면 순서) */
export function validateReport(draft: ReportDraft): ReportFieldError[] {
  const errors: ReportFieldError[] = [];
  if (!draft.reason) errors.push('reason');
  if (draft.reason === 'RIGHTS' && !draft.rightsHolder) errors.push('rightsHolder');
  if (draft.reason === 'RIGHTS' && draft.rightsHolder === 'yes' && !draft.notify) errors.push('notify');
  if (reportDetailRequired(draft) && draft.detail.trim() === '') errors.push('detail');
  return errors;
}

/** 위쪽 배너: 보내기 실패(입력은 그대로) · 429 하루 한도 · 404 지워졌거나 가려진 후기 */
export type ReportAlert = 'failed' | 'limited' | 'gone';

export interface ReportTarget {
  /** '김**' */
  author: string;
  /** '10월 25일 18:00 관람' */
  watched: string;
  /** 게시물 번호 '1234' */
  postId: string;
  /** 본문(한 줄 말줄임) */
  excerpt: string;
}

const DETAIL_MAX = 500;

const CHIP_STYLE = {
  height: 'auto',
  minHeight: 48,
  padding: '10px 14px',
  borderRadius: 'var(--r-lg)',
  whiteSpace: 'normal',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'center',
  gap: 2,
  textAlign: 'left',
} as const;

export interface ReportDialogProps {
  open: boolean;
  /** 닫기 아이콘·[닫기]·Esc */
  onClose: () => void;
  target: ReportTarget;
  draft: ReportDraft;
  onDraftChange: (draft: ReportDraft) => void;
  /** 보내기를 눌렀을 때 찾은 오류 칸 */
  errors?: readonly ReportFieldError[];
  /** 오류 요약을 그리며 첫 오류 칸으로 초점을 옮긴다 */
  focusError?: boolean;
  /** 보내기를 다시 누를 때마다 바꾸면 오류 요약이 다시 첫 오류로 초점을 옮긴다 */
  errorKey?: number;
  alert?: ReportAlert | null;
  /** 계정 이메일(가린 값, 예: 'ji****@k*****.com') */
  maskedEmail: string;
  /** 정부 신고기관 바로가기를 누를 때(게시물 주소 복사). 기본 동작(새 창 열기)은 그대로 둔다 */
  onOutbound?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** [신고 보내기]. 부르는 화면이 validateReport로 검사하고 확인 모달로 바꾼다 */
  onSubmit: () => void;
  restoreFocus?: boolean;
}

export function ReportDialog({
  open,
  onClose,
  target,
  draft,
  onDraftChange,
  errors = [],
  focusError = false,
  errorKey = 0,
  alert = null,
  maskedEmail,
  onOutbound,
  onSubmit,
  restoreFocus,
}: ReportDialogProps) {
  const base = useId().replace(/:/g, '');
  const [focusedReason, setFocusedReason] = useState<ReportReason | null>(null);
  const ids = {
    reason: `${base}-reason`,
    rightsHolder: `${base}-rh`,
    notify: `${base}-nc`,
    detail: `${base}-detail`,
  } satisfies Record<ReportFieldError, string>;
  const has = (e: ReportFieldError) => errors.includes(e);
  const set = (patch: Partial<ReportDraft>) => onDraftChange({ ...draft, ...patch });
  const detailRequired = reportDetailRequired(draft);
  const outbound = draft.reason === 'SCALPING' || draft.reason === 'MACRO';
  const detailCount = Array.from(draft.detail).length;

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title="후기 신고"
      closeLabel="후기 신고 닫기"
      layout="form"
      maxWidth={600}
      maxWidthLg={640}
      restoreFocus={restoreFocus}
    >
      <form
        className="col gap-5 md:gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {errors.length > 0 ? (
          <FormErrorSummary
            key={errorKey}
            title={`보내기 전에 ${errors.length}곳을 고쳐 주세요`}
            errors={errors.map((e) => ({ fieldId: ids[e], message: ERROR_TEXT[e] }))}
            focusFirst={focusError}
          />
        ) : null}
        {alert === 'failed' ? (
          <Banner tone="danger" icon="ic-alert-circle" role="alert">
            신고를 보내지 못했습니다. 입력한 내용은 그대로 있습니다. 다시 시도해 주세요.
          </Banner>
        ) : null}
        {alert === 'limited' ? (
          <Banner tone="warning" icon="ic-alert" role="alert">
            오늘은 더 신고할 수 없습니다. 내일 다시 시도해 주세요
          </Banner>
        ) : null}
        {alert === 'gone' ? (
          <Banner tone="warning" icon="ic-alert" role="alert">
            이미 지워졌거나 가려진 후기입니다
          </Banner>
        ) : null}

        <div className="card-flat col" role="group" aria-label="신고할 후기" style={{ padding: '12px 14px', gap: 4 }}>
          <p className="t-sm fw-b">
            {[target.author, target.watched].filter(Boolean).join(' · ')}
            {target.author || target.watched ? ' · ' : ''}게시물 <span className="num">{target.postId}</span>
          </p>
          {target.excerpt ? <p className="t-sm muted ellipsis">{target.excerpt}</p> : null}
        </div>

        <fieldset
          className="col"
          style={{ gap: 8 }}
          id={ids.reason}
          role="radiogroup"
          aria-labelledby={`${base}-reason-l`}
          aria-describedby={has('reason') ? `${base}-reason-err` : undefined}
          aria-required="true"
        >
          <legend className="label" id={`${base}-reason-l`} style={{ marginBottom: 10 }}>
            신고하는 이유를 골라 주세요 <span className="opt">(필수)</span>
          </legend>
          {has('reason') ? <ErrorMsg id={`${base}-reason-err`}>{ERROR_TEXT.reason}</ErrorMsg> : null}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {REPORT_REASONS.map((r) => {
              const id = `${base}-reason-${r.value}`;
              const checked = draft.reason === r.value;
              return (
                <label key={r.value} className={cx('chip', checked && 'is-selected', focusedReason === r.value && 'is-focus')} htmlFor={id} style={CHIP_STYLE}>
                  <input
                    className="sr-only"
                    type="radio"
                    name={`${base}-reason`}
                    id={id}
                    value={r.value}
                    checked={checked}
                    aria-invalid={has('reason') ? true : undefined}
                    aria-describedby={r.hint ? `${id}-h` : undefined}
                    onChange={() => set({ reason: r.value })}
                    onFocus={() => setFocusedReason(r.value)}
                    onBlur={() => setFocusedReason(null)}
                  />
                  <span>{r.label}</span>
                  {r.hint ? (
                    <span className="t-xs" id={`${id}-h`} style={{ fontWeight: 400 }}>
                      {r.hint}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>

        {outbound ? (
          <div className="banner banner-info">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body col" style={{ gap: 8 }}>
              <span className="banner-title" style={{ marginBottom: 0 }}>
                정부 신고기관에도 신고할 수 있습니다
              </span>
              <p>
                암표와 매크로 프로그램은 공연 분야 신고기관인 한국콘텐츠진흥원에 신고할 수 있습니다. 아래 버튼을 누르면 이 후기의 주소를
                복사하고 온라인 암표신고센터(culture.go.kr/singo)를 새 창으로 엽니다. 피켓에 보낸 신고는 신고기관에 자동으로 전달되지 않습니다.
              </p>
              <a
                className="btn btn-outline btn-sm"
                href={SCALPING_REPORT_CENTER_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="온라인 암표신고센터에 신고하기, 게시물 주소 복사, 새 창"
                style={{ alignSelf: 'flex-start' }}
                onClick={onOutbound}
              >
                온라인 암표신고센터에 신고하기
                <i className="ic ic-external" aria-hidden="true" />
              </a>
            </div>
          </div>
        ) : null}

        {draft.reason === 'RIGHTS' ? (
          <>
            <RadioRow
              id={ids.rightsHolder}
              legend="이 후기로 권리를 침해받은 본인인가요?"
              error={has('rightsHolder') ? ERROR_TEXT.rightsHolder : undefined}
              name={`${base}-rh`}
              value={draft.rightsHolder}
              options={[
                { value: 'yes', label: '네, 저에 대한 글입니다' },
                { value: 'no', label: '아니요' },
              ]}
              onChange={(v) => set({ rightsHolder: v as 'yes' | 'no', notify: v === 'yes' ? draft.notify : null })}
            />
            {draft.rightsHolder === 'yes' ? (
              <>
                <Banner tone="info" icon="ic-info">
                  권리를 침해받은 본인이 요청하면 정보통신망법 제44조의2에 따른 삭제 요청으로 처리합니다. 침해받은 사실을 &apos;자세한 내용&apos;에 적어
                  주세요. 침해 여부를 바로 판단하기 어려우면 그 후기를 30일 이내 동안 가리는 임시조치를 하고, 처리 결과를 신청하신 분과 글쓴이에게
                  알립니다.
                </Banner>
                <RadioRow
                  id={ids.notify}
                  legend="처리 결과를 받을 곳"
                  error={has('notify') ? ERROR_TEXT.notify : undefined}
                  name={`${base}-nc`}
                  value={draft.notify}
                  options={[
                    { value: 'APP', label: '앱 알림' },
                    {
                      value: 'EMAIL',
                      label: (
                        <>
                          계정 이메일(<span className="num">{maskedEmail}</span>)
                        </>
                      ),
                    },
                  ]}
                  onChange={(v) => set({ notify: v as ReportNotifyChannel })}
                />
              </>
            ) : null}
          </>
        ) : null}

        {draft.reason === 'ILLEGAL_FILMING' ? (
          <Banner tone="warning" icon="ic-alert">
            불법 촬영물로 신고된 후기는 확인할 때까지 바로 가립니다. 촬영물 속 피해자라면 한국여성인권진흥원에도 삭제 지원을 요청할 수 있습니다.
          </Banner>
        ) : null}

        <div className="field">
          <label className="label" htmlFor={ids.detail}>
            자세한 내용 <span className="opt">{detailRequired ? '(필수)' : '(선택)'}</span>
          </label>
          <textarea
            className="textarea"
            id={ids.detail}
            maxLength={DETAIL_MAX}
            value={draft.detail}
            onChange={(e) => set({ detail: e.target.value })}
            aria-required={detailRequired || undefined}
            aria-invalid={has('detail') ? true : undefined}
            aria-describedby={[has('detail') ? `${ids.detail}-err` : null, `${ids.detail}-h`, `${ids.detail}-c`].filter(Boolean).join(' ')}
            style={has('detail') ? { borderColor: 'var(--danger)', boxShadow: '0 0 0 1px var(--danger)' } : undefined}
          />
          {has('detail') ? <ErrorMsg id={`${ids.detail}-err`}>{ERROR_TEXT.detail}</ErrorMsg> : null}
          <div className="row between" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="hint" id={`${ids.detail}-h`}>
              어느 부분이 왜 문제인지 적어 주세요. 신고와 관계없는 개인정보는 적지 마세요.
            </span>
            <span className="counter" id={`${ids.detail}-c`} aria-live="polite">
              {detailCount}/{DETAIL_MAX}
            </span>
          </div>
        </div>

        <section className="card-flat col" aria-labelledby={`${base}-note`} style={{ padding: 16, gap: 8 }}>
          <h3 className="t-sm fw-b" id={`${base}-note`}>
            신고 전에 확인해 주세요
          </h3>
          <ul className="col t-sm" style={{ gap: 6, listStyle: 'disc', paddingLeft: 18 }}>
            <li>신고한 후기는 운영팀이 운영정책에 따라 검토합니다. 신고만으로 후기가 바로 지워지지는 않습니다(불법 촬영물 신고는 확인할 때까지 바로 가립니다).</li>
            <li>신고하신 분이 누구인지는 글쓴이에게 알리지 않습니다.</li>
            <li>같은 후기는 한 번만 신고할 수 있고, 하루에 10건까지 신고할 수 있습니다.</li>
            <li>사실과 다른 신고나 다른 사람을 괴롭히려는 반복 신고는 처리하지 않으며, 운영정책에 따라 이용이 제한될 수 있습니다.</li>
            <li>검토 결과는 3영업일 안에 알림으로 알려 드립니다. 권리 침해 삭제 요청은 지체 없이 처리합니다.</li>
            <li>신고 내용은 처리가 끝나고 1년 동안 보관한 뒤 지웁니다.</li>
          </ul>
        </section>

        <div className="flex flex-col-reverse gap-2 md:flex-row md:flex-wrap md:items-center md:justify-end">
          <button className="btn btn-ghost btn-block md:w-auto" type="button" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-primary btn-lg btn-block md:w-auto md:min-w-[160px]" type="submit">
            신고 보내기
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

export interface ReportConfirmDialogProps {
  open: boolean;
  /** [다시 고치기]·Esc: 입력을 그대로 둔 채 신고 모달로 돌아간다 */
  onBack: () => void;
  onConfirm: () => void;
  /** 보내는 중(버튼 '보내는 중', aria-busy) */
  busy?: boolean;
  target: ReportTarget;
  draft: ReportDraft;
  restoreFocus?: boolean;
}

export function ReportConfirmDialog({ open, onBack, onConfirm, busy = false, target, draft, restoreFocus }: ReportConfirmDialogProps) {
  const descId = `${useId()}-desc`;
  const rightsRequest = draft.reason === 'RIGHTS' && draft.rightsHolder === 'yes';
  const outbound = draft.reason === 'SCALPING' || draft.reason === 'MACRO';
  return (
    <ModalFrame
      open={open}
      onClose={onBack}
      title="이 내용으로 신고할까요?"
      hideClose
      role="alertdialog"
      describedBy={descId}
      layout="confirm"
      maxWidth={480}
      restoreFocus={restoreFocus}
    >
      <dl className="kv card" style={{ padding: 16 }}>
        <dt>대상</dt>
        <dd>
          {target.author ? `${target.author}의 후기 · ` : ''}게시물 <span className="num">{target.postId}</span>
        </dd>
        <dt>이유</dt>
        <dd>{draft.reason ? reportReasonLabel(draft.reason) : ''}</dd>
        <dt>자세한 내용</dt>
        <dd className="line-clamp-2">{draft.detail.trim() || '적지 않음'}</dd>
        {rightsRequest ? (
          <>
            <dt>처리 방식</dt>
            <dd>정보통신망법 제44조의2 삭제 요청</dd>
            <dt>결과 받을 곳</dt>
            <dd>{draft.notify === 'EMAIL' ? '계정 이메일' : '앱 알림'}</dd>
          </>
        ) : null}
      </dl>
      <div className="banner banner-warning">
        <i className="ic ic-alert" aria-hidden="true" />
        <div className="banner-body col" id={descId} style={{ gap: 6 }}>
          <p>보낸 신고는 고치거나 취소할 수 없습니다. 사실과 다른 신고는 이용이 제한될 수 있습니다.</p>
          {outbound ? (
            <p>
              정부 신고기관 신고는 따로 해야 합니다{' '}
              <a className="link" href={SCALPING_REPORT_CENTER_URL} target="_blank" rel="noopener noreferrer" aria-label="온라인 암표신고센터, 새 창">
                온라인 암표신고센터
                <i className="ic ic-external ic-14" aria-hidden="true" />
              </a>
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 md:flex-row md:flex-wrap md:items-center md:justify-end">
        <button className="btn btn-ghost btn-block md:w-auto" type="button" onClick={onBack}>
          다시 고치기
        </button>
        {busy ? (
          <button className="btn btn-primary btn-lg btn-block md:w-auto md:min-w-[160px]" type="button" aria-busy="true" aria-disabled="true">
            <span className="spinner" aria-hidden="true" />
            보내는 중
          </button>
        ) : (
          <button className="btn btn-primary btn-lg btn-block md:w-auto md:min-w-[160px]" type="button" onClick={onConfirm}>
            신고합니다
          </button>
        )}
      </div>
    </ModalFrame>
  );
}

function Banner({ tone, icon, role, children }: { tone: 'info' | 'warning' | 'danger'; icon: string; role?: 'alert'; children: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={role}>
      <i className={`ic ${icon}`} aria-hidden="true" />
      <div className="banner-body">{children}</div>
    </div>
  );
}

function ErrorMsg({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p className="error-msg" id={id}>
      <i className="ic ic-alert-circle" aria-hidden="true" />
      {children}
    </p>
  );
}

function RadioRow({
  id,
  legend,
  error,
  name,
  value,
  options,
  onChange,
}: {
  id: string;
  legend: string;
  error?: string;
  name: string;
  value: string | null;
  options: readonly { value: string; label: ReactNode }[];
  onChange: (value: string) => void;
}) {
  return (
    <fieldset
      className="col"
      style={{ gap: 10 }}
      id={id}
      role="radiogroup"
      aria-labelledby={`${id}-l`}
      aria-describedby={error ? `${id}-err` : undefined}
      aria-required="true"
    >
      <legend className="label" id={`${id}-l`} style={{ marginBottom: 10 }}>
        {legend} <span className="opt">(필수)</span>
      </legend>
      {error ? <ErrorMsg id={`${id}-err`}>{error}</ErrorMsg> : null}
      <div className="col gap-2.5 md:flex-row md:flex-wrap md:gap-6">
        {options.map((o) => (
          <label key={o.value} className="check-row" htmlFor={`${id}-${o.value}`}>
            <input
              className="rd"
              type="radio"
              name={name}
              id={`${id}-${o.value}`}
              value={o.value}
              checked={value === o.value}
              aria-invalid={error ? true : undefined}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
