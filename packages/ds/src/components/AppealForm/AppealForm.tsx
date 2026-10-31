'use client';
// CMP-063 AppealForm(소명 제출). 정본: d2 CMP-063(변형 restriction·reclaim·fraud, 상태 default·submitted·overdue), d5 §5.24, 캔버스 보드 SCR-042.
// 보드 마크업(위에서 아래로):
//   default   — 사안 카드(AppealCaseCard, 처리 일정 포함) → <form class="col" aria-label="소명 작성">
//               .field(라벨 '소명 내용 (필수)' → 힌트(민감정보 안내) → .textarea(min-height 168) → .counter '남은 글자 N자 / 2,000자'(aria-live))
//               → 제출 버튼(btn-primary btn-lg btn-block)
//   submitted — 사안 카드(처리 일정 없음) → .card(role="status"): 성공 아이콘 + '소명을 제출했습니다' + 제출 시각,
//               kv(상태 <제출됨> · 검토 결과), '처리 일정' 한 줄, 이동 버튼
//   overdue   — 사안 카드(기한 줄에 '기한 지남' 위험 배지) → 경고 띠(role="alert") → 문의하기 버튼
// fraud(부정 예매 소명, d5 §5.24 '부정 예매 소명' 그림): 사안 카드에 사유 범주 여럿·잠긴 티켓 묶음을 싣고(AppealCaseCard),
//   default에서만 카드와 폼 사이에 정보 띠(notice, 가족·지인 대리 예매 안내)를 둔다. 결과(인정·불인정)는 앱이 사안 카드 + 결과 카드로 그린다.
// - 글자 수는 grapheme(사람이 보는 한 글자) 단위로 세고 천 단위 쉼표를 붙인다. 넘치면 'N자 넘었습니다'를 오류 색으로 보인다(입력을 자르지 않는다).
// - 화면 문구(제목·사유·기한·처리 일정·힌트·결과 안내)는 앱이 props로 준다. 클라이언트 부품이다(서버 페이지는 onSubmit 없이 직렬화되는 값만 넘긴다).
import { useState, type FormEvent, type ReactNode } from 'react';
import { joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { countGraphemes, formatNumber } from '../../lib/format';
import { Icon } from '../../icons';
import { FieldLabelText } from '../Field/Field';
import { AppealCaseCard, type AppealLockedTickets, type AppealVariant } from './AppealCaseCard';

export type AppealFormState = 'default' | 'submitted' | 'overdue';

export interface AppealSubmittedInfo {
  /** 기본 '소명을 제출했습니다' */
  title?: ReactNode;
  /** '10/25(일) 15:20 제출' */
  submittedAtText: ReactNode;
  /** 상태 배지 글(기본 '제출됨') */
  statusLabel?: ReactNode;
  /** 검토 결과 칸 글(기본 '검토 중') */
  reviewText?: ReactNode;
  /** 처리 일정(결과 안내 날짜까지) */
  scheduleText: ReactNode;
  /** 아래 이동 버튼(예: 계정 설정 링크) */
  action?: ReactNode;
}

export interface AppealOverdueInfo {
  /** 경고 띠 글(예: '기한이 지났습니다. 고객센터로 문의해 주세요') */
  message: ReactNode;
  /** 기한 줄 배지 글(기본 '기한 지남') */
  badgeLabel?: ReactNode;
  /** 띠 아래 버튼(예: 문의하기 링크) */
  action?: ReactNode;
}

export interface AppealFormProps {
  /** 칸·제목 id 앞부분(예: 'ap' → ap-text·ap-hint·ap-count·ap-h) */
  idPrefix: string;
  variant?: AppealVariant;
  state?: AppealFormState;
  /** 사안 카드 제목('예매 제한' · '양도 회수 예고' · '부정 예매 소명 요청') */
  title: ReactNode;
  /** 제목 오른쪽 경고 배지 글('제한 중' · '답변 기다림') */
  statusLabel?: ReactNode;
  /** 사유 범주 하나(restriction·reclaim) */
  reasonCategory?: ReactNode;
  /** 사유 범주 여럿(fraud: 알린 범주 모두). 있으면 reasonCategory 대신 쓴다 */
  reasonCategories?: readonly ReactNode[];
  /** 대상 티켓(양도 회수) · 공연과 회차(fraud) */
  target?: ReactNode;
  /** 대상 칸 이름(기본 '대상 티켓') */
  targetLabel?: ReactNode;
  /** 잠긴 티켓 묶음(fraud) */
  lockedTickets?: AppealLockedTickets;
  /** 작성 중 카드와 폼 사이 정보 띠(fraud: 가족·지인 대리 예매 안내) */
  notice?: ReactNode;
  /** '10/27(화) 18:00' */
  deadlineText: ReactNode;
  /** '남은 시간 51시간' */
  remainingText?: ReactNode;
  /** 작성 중 처리 일정 한 줄 */
  scheduleText: ReactNode;
  /** 폼 이름(aria-label, 기본 '소명 작성') */
  formLabel?: string;
  /** 칸 라벨(기본 '소명 내용') */
  fieldLabel?: ReactNode;
  /** 늘 보이는 안내(민감정보는 적지 않아도 된다는 글) */
  hint: ReactNode;
  /** 최대 글자 수(grapheme, 기본 2,000) */
  maxLength?: number;
  defaultValue?: string;
  /** 제출 버튼 글(기본 '제출') */
  submitLabel?: string;
  submitted?: AppealSubmittedInfo;
  overdue?: AppealOverdueInfo;
  onSubmit?: (text: string, event: FormEvent<HTMLFormElement>) => void;
  className?: string;
}

export function AppealForm({
  idPrefix,
  variant = 'restriction',
  state = 'default',
  title,
  statusLabel,
  reasonCategory,
  reasonCategories,
  target,
  targetLabel,
  lockedTickets,
  notice,
  deadlineText,
  remainingText,
  scheduleText,
  formLabel = '소명 작성',
  fieldLabel = '소명 내용',
  hint,
  maxLength = 2000,
  defaultValue = '',
  submitLabel = '제출',
  submitted,
  overdue,
  onSubmit,
  className,
}: AppealFormProps) {
  const [text, setText] = useState(defaultValue);
  const ids = {
    heading: `${idPrefix}-h`,
    text: `${idPrefix}-text`,
    hint: `${idPrefix}-hint`,
    count: `${idPrefix}-count`,
    done: `${idPrefix}-done-h`,
  };
  const count = countGraphemes(text);
  const over = count > maxLength;
  const counterText = over
    ? `${formatNumber(count - maxLength)}자 넘었습니다 / ${formatNumber(maxLength)}자`
    : `남은 글자 ${formatNumber(maxLength - count)}자 / ${formatNumber(maxLength)}자`;

  const isOverdue = state === 'overdue';
  const card = (
    <AppealCaseCard
      headingId={ids.heading}
      variant={variant}
      title={title}
      statusLabel={statusLabel}
      reasonCategory={reasonCategory}
      reasonCategories={reasonCategories}
      target={target}
      targetLabel={targetLabel}
      deadline={{ text: deadlineText, remainingText, overdue: isOverdue, overdueLabel: overdue?.badgeLabel }}
      schedule={state === 'default' ? scheduleText : undefined}
      lockedTickets={lockedTickets}
    />
  );

  return (
    <div className={cx('col gap-5', className)} data-variant={variant} data-state={state}>
      {card}

      {state === 'default' && notice ? (
        <div className="banner banner-info">
          <Icon name="info" />
          <div className="banner-body">{notice}</div>
        </div>
      ) : null}

      {state === 'default' ? (
        <form
          className="col gap-5"
          aria-label={formLabel}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit?.(text, e);
          }}
        >
          <div className="field">
            <label className="label" htmlFor={ids.text}>
              <FieldLabelText label={fieldLabel} requiredMark />
            </label>
            <span className="hint" id={ids.hint}>
              {hint}
            </span>
            <textarea
              className="textarea"
              id={ids.text}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={joinIds(ids.hint, ids.count)}
              aria-invalid={over ? true : undefined}
              style={over ? { minHeight: 168, borderColor: 'var(--danger)', boxShadow: '0 0 0 1px var(--danger)' } : { minHeight: 168 }}
            />
            <span className={cx('counter', over && 'tx-danger')} id={ids.count} aria-live="polite">
              {counterText}
            </span>
          </div>
          <button className="btn btn-primary btn-lg btn-block" type="submit">
            {submitLabel}
          </button>
        </form>
      ) : null}

      {state === 'submitted' && submitted ? (
        <section className="card col gap-3 px-4 py-5 md:px-5 md:py-6" role="status" aria-labelledby={ids.done}>
          <div className="row" style={{ gap: 12 }}>
            <span className="state-icon is-success" style={{ width: 44, height: 44 }}>
              <Icon name="check-circle" />
            </span>
            <div className="col" style={{ gap: 2 }}>
              <h2 id={ids.done} className="t-lg">
                {submitted.title ?? '소명을 제출했습니다'}
              </h2>
              <span className="t-sm muted">{submitted.submittedAtText}</span>
            </div>
          </div>
          <dl className="kv">
            <dt>상태</dt>
            <dd>
              <span className="badge badge-primary">{submitted.statusLabel ?? '제출됨'}</span>
            </dd>
            <dt>검토 결과</dt>
            <dd>{submitted.reviewText ?? '검토 중'}</dd>
          </dl>
          <div className="col" style={{ gap: 4 }}>
            <span className="eyebrow">처리 일정</span>
            <p className="t-sm">{submitted.scheduleText}</p>
          </div>
          {submitted.action}
        </section>
      ) : null}

      {isOverdue && overdue ? (
        <div className="col gap-4">
          <div className="banner banner-warning" role="alert">
            <Icon name="alert" />
            <div className="banner-body">{overdue.message}</div>
          </div>
          {overdue.action}
        </div>
      ) : null}
    </div>
  );
}
