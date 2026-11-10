// SCR-009 추가 검증의 그림 조각(d5 §5.9, 캔버스 보드 SCR-009-m·t·d). 퍼블리싱 미리보기(QueueVerifyPreview)와 데이터에 잇는 화면(QueueVerifyLive)이 함께 쓴다.
// 서버 값에서 온 글(사유 범주·보낸 이의 내용)은 React 글자 자식(글 노드)으로만 그린다. HTML로 넣지 않는다(ASVS 3.2.2).
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { cx } from '@/shared/lib/cx';
import { COPY } from '../model/view';

/** 단계 표시: 휴대폰은 간격을 4px로 줄이고, 폭 320에서는 상자 안에서만 가로로 민다. current는 0 안내 · 1 사람 확인 · 2 본인확인 · 3 완료 */
export function VerifySteps({ current }: { current: number }) {
  const steps = ['안내', '사람 확인', '본인확인', '완료'];
  return (
    <nav className="stepper relative gap-1 overflow-x-auto md:gap-2" aria-label="검증 단계">
      {steps.map((label, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <Fragment key={label}>
            {i > 0 ? <span className={cx('step-line min-w-2 basis-2 md:min-w-3 md:basis-4', (done || now) && 'is-done')} aria-hidden="true" /> : null}
            <span className={cx('step gap-1 md:gap-2', done && 'is-done', now && 'is-current')} aria-current={now ? 'step' : undefined}>
              <span className="step-num">{done ? <i className="ic ic-check" aria-hidden="true" /> : i + 1}</span>
              {label}
              {done ? <span className="sr-only"> 완료</span> : null}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}

/** 확인된 사항의 범주(세부 기준은 공개하지 않는다, d5 §5.9 ①). label은 글 노드로만 */
export function CategoryRow({ label, center = false }: { label: string; center?: boolean }) {
  return (
    <div className={cx('row wrap', center && 'justify-center')} style={{ gap: 6 }}>
      <span className="t-sm muted">확인된 사항의 범주</span>
      <span className="badge badge-outline">{label}</span>
    </div>
  );
}

/** ① 안내 배너 */
export function IntroBanner({ reason }: { reason: string | null }) {
  return (
    <section className="banner banner-info" role="region" aria-label="추가 검증 안내">
      <i className="ic ic-shield" aria-hidden="true" />
      <div className="banner-body col" style={{ gap: 10 }}>
        <p className="t-md fw-b">{COPY.intro}</p>
        {reason ? <CategoryRow label={reason} /> : null}
        <p>{COPY.appealHint}</p>
      </div>
    </section>
  );
}

/** 위험 색 안내 띠(위젯 실패·다른 분 등). 버튼·링크는 action으로 */
export function DangerBanner({ text, action, sub }: { text: string; action?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="banner banner-danger" role="alert">
      <i className="ic ic-alert-circle" aria-hidden="true" />
      <div className="banner-body col" style={{ gap: 8 }}>
        <span>{text}</span>
        {sub}
        {action}
      </div>
    </div>
  );
}

/** ④ 순번 안내 */
export function TurnNote() {
  return (
    <p className="row t-sm" style={{ alignItems: 'flex-start', gap: 8 }}>
      <i className="ic ic-info ic-16 muted" aria-hidden="true" style={{ marginTop: 2 }} />
      <span>{COPY.turnNote}</span>
    </p>
  );
}

const RESULT = 'col items-center text-center';
const RESULT_STYLE = { gap: 14, padding: '32px 8px 16px' } as const;

/** 통과: 차례 전 '원래 순번으로 돌아갑니다' · 지남 '바로 입장합니다'. 고르는 중이면 글 없이 스피너만. 넘어가는 중 스피너(새 글 없음, d5 추천 적용 2026-10-28) */
export function PassedResult({ turn }: { turn: 'before' | 'after' | 'deciding' }) {
  return (
    <section className={RESULT} role="status" style={RESULT_STYLE}>
      <span className="state-icon is-success">
        <i className="ic ic-check-circle" aria-hidden="true" />
      </span>
      {turn === 'deciding' ? null : <p className="t-lg">{turn === 'before' ? COPY.passBefore : COPY.passAfter}</p>}
      <span className="spinner muted" aria-hidden="true" />
    </section>
  );
}

/** 재검토 결과 인정 */
export function AcceptedResult({ turn, spinner = false }: { turn: 'before' | 'after' | 'deciding'; spinner?: boolean }) {
  return (
    <section className={RESULT} role="alert" style={RESULT_STYLE}>
      <span className="state-icon is-success">
        <i className="ic ic-check-circle" aria-hidden="true" />
      </span>
      {turn === 'deciding' ? null : <p className="t-lg">{turn === 'before' ? COPY.acceptedBefore : COPY.acceptedAfter}</p>}
      <span className="badge badge-success">재검토 결과 · 인정</span>
      {spinner ? <span className="spinner muted" aria-hidden="true" /> : null}
    </section>
  );
}

/** 재검토 결과 기각: 이 대기 참여만 끝나고 계정 제재는 아니다(docs/planning/03 §2.1, POL-006) */
export function RejectedResult({ reason }: { reason: string | null }) {
  return (
    <section className={RESULT} role="alert" style={RESULT_STYLE}>
      <span className="state-icon">
        <i className="ic ic-x-circle" aria-hidden="true" />
      </span>
      <p className="t-lg">{COPY.rejected}</p>
      {reason ? <CategoryRow label={reason} center /> : null}
      <p className="t-sm muted">{COPY.rejectedNote}</p>
      <Link className="link-more" href="/help/inquiries/new">
        문의하기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </section>
  );
}

/** ⑤ 접수 뒤: 보낸 내용(이 화면에서 보냈을 때만)·진행 단계·안내. 배지는 GAT-280 전까지 <접수됨>만(ADR-0259 결정 3) */
export function AppealReceived({ text }: { text?: string | undefined }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      {text !== undefined && text !== '' ? (
        <div className="card-flat col" style={{ gap: 6, padding: '14px 16px' }}>
          <span className="eyebrow">보낸 내용</span>
          <p className="t-sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {text}
          </p>
        </div>
      ) : null}
      <ol className="stepper relative gap-1 overflow-x-auto md:gap-2" aria-label="재검토 진행">
        <li className="step is-current gap-1 md:gap-2" aria-current="step">
          <span className="step-num">
            <i className="ic ic-check" aria-hidden="true" />
          </span>
          접수됨
        </li>
        <li className="step-line min-w-2 basis-2 md:min-w-3 md:basis-4" aria-hidden="true" />
        <li className="step gap-1 md:gap-2">
          <span className="step-num">2</span>검토 중
        </li>
        <li className="step-line min-w-2 basis-2 md:min-w-3 md:basis-4" aria-hidden="true" />
        <li className="step gap-1 md:gap-2">
          <span className="step-num">3</span>결과 통지
        </li>
      </ol>
      <p className="hint" role="status">
        {COPY.received}
      </p>
    </div>
  );
}

/** ⑤ 머리(제목과 <접수됨> 배지) */
export function AppealHeading({ received }: { received: boolean }) {
  return (
    <div className="row between">
      <h2 className="t-md fw-b" id="ap-h">
        설명 요청·재검토 신청
      </h2>
      {received ? <span className="badge badge-primary">접수됨</span> : null}
    </div>
  );
}

/** ⑥ 개인정보 처리방침 링크 */
export function PrivacyLink() {
  return (
    <Link className="link-more self-start" href="/policy/privacy">
      개인정보 처리방침: 자동화된 결정
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );
}

/** 본문 칸: 휴대폰 본문이 바로 흐르고, 태블릿 가운데 560 칸, 데스크톱 바탕 위 560 카드 */
export function VerifyFrame({ children }: { children: ReactNode }) {
  return (
    <main
      className="page-main items-center px-4 pt-6 pb-10 md:px-6 md:pt-10 md:pb-12 lg:bg-(--surface-basement) lg:px-8 lg:pt-12 lg:pb-16"
      id="main"
      tabIndex={-1}
    >
      <div className="col w-full max-w-[560px] gap-6 lg:rounded-(--r-xl) lg:border lg:border-(--border) lg:bg-(--surface) lg:px-7 lg:py-8">{children}</div>
    </main>
  );
}
