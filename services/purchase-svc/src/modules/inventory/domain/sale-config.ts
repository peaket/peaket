// core-svc의 회차 판매 설정 사본(event_sale_config)을 purchase-svc가 읽는 값(BAT-051, HOT-252).
// core DB에 직접 접속하지 않고 core-svc의 내부 HTTP 경로가 답한 payload를 좌석맵 판 설정 위에 덮는다.
import type { SalePolicyRule } from '@peaket/validation/sale-policy';

/** 회차 판매 설정 사본 가운데 purchase-svc가 쓰는 칸. core-svc EventSaleConfig와 같은 모양이다 */
export interface EventSaleConfigOverlay {
  /** 판매 승인·설정 고치기의 판. queue-svc처럼 purchase-svc도 판이 클 때만 바꾼다 */
  rev: number;
  /** 회차 1인 한도(규칙이 낮추기 전 값) */
  perPersonLimit: number;
  /** 판매 종료 시각(epoch ms) */
  saleEndsAtMs: number;
  /** 승인한 판매 정책 규칙(공개본) */
  salePolicy: readonly SalePolicyRule[];
  /** 그 회차에 걸리는 규칙이 쓰는 명단 키 모두(입장 토큰 lst의 후보) */
  eligLists: readonly string[];
  /** 게시한 좌석맵 판(선택). 지금 파일 판과 다르면 로그만 남기고 파일 판을 쓴다 */
  layoutVersion?: number;
}

/** core-svc의 판매 설정 사본을 읽지 못했다(네트워크·5xx·모양 오류). 닫힌 쪽으로 홀드를 503으로 답한다 */
export class SaleConfigUnavailable extends Error {
  constructor(readonly reason: string, options?: { cause?: unknown }) {
    super(`회차 판매 설정을 읽지 못했다: ${reason}`, options);
    this.name = 'SaleConfigUnavailable';
  }
}
