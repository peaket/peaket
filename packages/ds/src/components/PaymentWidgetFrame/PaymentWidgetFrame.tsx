// CMP-027 PaymentWidgetFrame. 결제사 결제 UI를 감싸는 프레임(d2 CMP-027). 퍼블리싱 단계라 실제 SDK는 싣지 않고,
// 캔버스 보드(SCR-011)의 '결제 프레임' 자리 그림을 그대로 낸다: 프레임 이름(.eyebrow) + 점선 카드(.card, border-style:dashed).
// - pg: toss(주문서형 결제 위젯이 결제수단까지 그림) · portone(결제수단을 고른 뒤 [결제하기]로 포트원 결제창이 열림)
// - state: loading(스켈레톤, aria-busy) · ready · error(role="alert") · pg-switched(프레임 위 warning 배너 role="status")
// - 프레임은 role="group"이고 이름은 '결제 프레임 · <결제사 이름>'이다(위젯 안쪽 접근성은 결제사 위젯에 맡긴다).
// 서버 컴포넌트에서도 쓴다. 데이터 연결 단계에서 점선 카드 자리에 결제사 SDK가 그리는 요소를 넣는다.
import { useId, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export type PaymentPg = 'toss' | 'portone';
export type PaymentFrameState = 'loading' | 'ready' | 'error' | 'pg-switched';

/** 프레임 이름에 붙는 결제사 이름(보드 문구) */
export const PAYMENT_PG_LABEL: Record<PaymentPg, string> = {
  toss: '토스페이먼츠 결제 위젯',
  portone: '포트원 결제창',
};

export interface PaymentWidgetFrameProps {
  pg: PaymentPg;
  state?: PaymentFrameState;
  /** 점선 카드 최소 높이(px). 보드: 휴대폰 140·100, 태블릿 160·120, 데스크톱 200·140. bodyClassName을 주면 인라인 높이를 두지 않는다 */
  minHeight?: number;
  /** 점선 카드에 붙일 클래스(반응형 최소 높이 등) */
  bodyClassName?: string;
  /** error 상태의 글 */
  errorMessage?: ReactNode;
  /** 자리 글을 바꿀 때(기본: 보드 문구) */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const DASHED: CSSProperties = {
  borderStyle: 'dashed',
  gap: 8,
  padding: '20px 16px',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};

export function PaymentWidgetFrame({
  pg,
  state = 'ready',
  minHeight,
  errorMessage = '결제 화면을 불러오지 못했습니다. 다시 시도해 주세요. 요금은 청구되지 않았습니다',
  children,
  bodyClassName,
  className,
  style,
}: PaymentWidgetFrameProps) {
  const labelId = `${useId()}-pgf`;
  const height = bodyClassName && minHeight === undefined ? undefined : (minHeight ?? (pg === 'toss' ? 140 : 100));
  let body: ReactNode;
  if (state === 'loading') {
    body = (
      <div className={cx('card col', bodyClassName)} aria-busy="true" style={{ minHeight: height, gap: 10, padding: '20px 16px' }}>
        <span className="skel" style={{ height: 18, width: '55%' }} />
        <span className="skel" style={{ height: 44 }} />
        <span className="skel" style={{ height: 44 }} />
        <span className="skel" style={{ height: 44, width: '70%' }} />
      </div>
    );
  } else if (state === 'error') {
    body = (
      <div className={cx('card col', bodyClassName)} role="alert" style={{ ...DASHED, minHeight: height }}>
        <Icon name="alert-circle" size={24} className="tx-danger" />
        <p className="t-sm fw-b">{errorMessage}</p>
      </div>
    );
  } else {
    body = (
      <div className={cx('card col', bodyClassName)} style={{ ...DASHED, minHeight: height }}>
        <Icon name={pg === 'toss' ? 'lock' : 'external'} size={24} className="muted" />
        {children ??
          (pg === 'toss' ? (
            <p className="t-sm fw-b">토스페이먼츠 결제 위젯이 이 자리에 그려집니다</p>
          ) : (
            <>
              <p className="t-sm fw-b">[결제하기]를 누르면 포트원 결제창으로 넘어갑니다</p>
              <p className="t-xs muted">결제가 끝나면 이 화면으로 돌아와 결제를 접수합니다</p>
            </>
          ))}
      </div>
    );
  }
  return (
    <>
      {state === 'pg-switched' ? (
        <div className="banner banner-warning" role="status">
          <Icon name="transfer" />
          <div className="banner-body">결제 대행사 장애로 다른 결제 대행사로 결제합니다</div>
        </div>
      ) : null}
      <div className={cx('col', className)} style={{ gap: 6, ...style }} role="group" aria-labelledby={labelId}>
        <span className="eyebrow" id={labelId}>
          결제 프레임 · {PAYMENT_PG_LABEL[pg]}
        </span>
        {body}
      </div>
    </>
  );
}
