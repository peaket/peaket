// CMP-054 RefundQuote(ticket 변형). 캔버스 보드 SCR-038 '환급 예상액' 카드 마크업을 그대로 낸다. 서버 컴포넌트에서도 쓴다.
//   <section class="card col" aria-labelledby><div class="row between"><h2>환급 예상액</h2><span class="badge">1장 · …</span></div>
//   <dl class="kv">결제 금액 · 취소 수수료(20%)</dl><div class="divider"></div><div class="row between"><span class="kv-total">환급 예상액</span>…</div>
//   <p class="t-sm">근거 문장</p><p class="t-sm muted row"><i class="ic ic-receipt">환급 수단</p></section>
// - state: ready(명세) · loading(스켈레톤, aria-busy, '계산하는 중' role=status) · empty(좌석을 고르기 전, .card-flat 안내).
// - 공제액과 환급액은 글자로 적는다. 확인 버튼보다 먼저 읽히도록 부르는 쪽이 이 카드를 버튼 앞에 둔다(d2 CMP-054).
//   데스크톱 고정 패널처럼 버튼을 카드 안에 둘 때는 footer로 넣어 명세 뒤에 오게 한다.
// - 금액 계산(공제율 기준점 정수 연산, POL-032)은 부르는 쪽이 한 곳에서 하고 이 부품은 글만 그린다.
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export interface RefundQuoteRow {
  label: ReactNode;
  value: ReactNode;
}

export interface RefundQuoteProps {
  state?: 'ready' | 'loading' | 'empty';
  /** 제목 id(카드의 aria-labelledby) */
  headingId: string;
  /** 기본 '환급 예상액' */
  title?: ReactNode;
  /** 제목 글자 클래스(휴대폰 't-md fw-b', 데스크톱 패널 't-lg') */
  titleClassName?: string;
  /** 제목 줄 오른쪽 배지('1장 · R구역 12열 8번') */
  badge?: ReactNode;
  /** 명세 앞 한 줄(데스크톱 패널의 좌석 글) */
  summary?: ReactNode;
  /** 결제 금액 · 취소 수수료(20%) … */
  rows?: readonly RefundQuoteRow[];
  /** 기본 '환급 예상액' */
  totalLabel?: ReactNode;
  /** '₩123,200' */
  total?: ReactNode;
  /** 근거 문장('공연 5일 전이라 입장료의 20%를 공제하고 환급합니다(소비자분쟁해결기준)') */
  basis?: ReactNode;
  /** 환급 수단 줄 */
  method?: { icon?: IconName; text: ReactNode };
  /** empty 안내(기본 '취소할 좌석을 고르면 환급 예상액을 계산합니다') */
  emptyText?: ReactNode;
  /** loading 상태 글(기본 '계산하는 중') */
  loadingText?: ReactNode;
  /** 명세 뒤(데스크톱 패널의 구분선·실행 버튼·안내) */
  footer?: ReactNode;
  /** 여백은 휴대폰 보드 값(간격 12·여백 16). 넓은 화면 여백은 반응형 유틸로 더한다(예: 'md:px-5 md:py-[18px]') */
  className?: string;
  style?: CSSProperties;
}

export function RefundQuote({
  state = 'ready',
  headingId,
  title = '환급 예상액',
  titleClassName = 't-md fw-b',
  badge,
  summary,
  rows = [],
  totalLabel = '환급 예상액',
  total,
  basis,
  method,
  emptyText = '취소할 좌석을 고르면 환급 예상액을 계산합니다',
  loadingText = '계산하는 중',
  footer,
  className,
  style,
}: RefundQuoteProps) {
  const heading = (
    <h2 className={titleClassName} id={headingId}>
      {title}
    </h2>
  );

  if (state === 'empty') {
    return (
      <section className={cx('card-flat col gap-1.5 p-4', className)} style={style} aria-labelledby={headingId}>
        {heading}
        <p className="t-sm muted">{emptyText}</p>
        {footer}
      </section>
    );
  }

  if (state === 'loading') {
    return (
      <section className={cx('card col gap-3 p-4', className)} style={style} aria-labelledby={headingId} aria-busy="true">
        <div className="row between" style={{ gap: 8 }}>
          {heading}
          <span className="t-xs muted" role="status">
            {loadingText}
          </span>
        </div>
        <span className="skel" style={{ height: 20 }} />
        <span className="skel" style={{ height: 20, width: '80%' }} />
        <span className="skel" style={{ height: 28, width: '60%' }} />
        <span className="skel" style={{ height: 38 }} />
        {footer}
      </section>
    );
  }

  return (
    <section className={cx('card col gap-3 p-4', className)} style={style} aria-labelledby={headingId}>
      <div className="row between" style={{ gap: 8 }}>
        {heading}
        {badge ? <span className="badge">{badge}</span> : null}
      </div>
      {summary ? <p className="t-sm muted">{summary}</p> : null}
      <dl className="kv">
        {rows.map((r, i) => (
          <Fragment key={i}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="divider" />
      <div className="row between">
        <span className="kv-total">{totalLabel}</span>
        <span className="kv-total num">{total}</span>
      </div>
      {basis ? <p className="t-sm">{basis}</p> : null}
      {method ? (
        <p className="t-sm muted row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <Icon name={method.icon ?? 'receipt'} size={16} style={{ marginTop: 2 }} />
          <span>{method.text}</span>
        </p>
      ) : null}
      {footer}
    </section>
  );
}
