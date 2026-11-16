// 알림 신청·끄기 실패 문구: 오류 이름(type)으로 고른다(docs/frontend.md §4.1 '오류 모양'). 홈(HOT-300)과 공연 상세(HOT-311)가 같이 쓴다.
// 공연 상세 회차 매진의 취소표 알림(ADR-0272 결정 2)도 같은 함수가 알림 종류로 고른다.
// node --test가 바로 불러 보도록 상대 경로 .ts로 가져온다(시험 담당, BAT-040 T18)
import { problemName } from '../../shared/api/refresh.ts';

export function alertFailureText(e: unknown, on: boolean, kind: 'open' | 'cancel' = 'open'): string {
  const type = problemName(e);
  if (type === 'subscription-limit') return '알림 신청 수를 넘었습니다. 관심 공연에서 쓰지 않는 알림을 꺼 주세요';
  // 취소표 알림 신청은 판매 종료 때 끝난다(ADR-0213 결정 5). 오픈 알림은 오픈 시각이 지나면 신청할 수 없다
  if (kind === 'cancel' ? type === 'sale-ended' : type === 'open-passed') return kind === 'cancel' ? '판매가 끝나 알림을 신청할 수 없습니다' : '오픈 시각이 지나 오픈 알림을 신청할 수 없습니다';
  // 홈 첫 JS에도 실리는 함수라 같은 글 꼴은 한 번만 적는다(첫 JS 예산, docs/frontend.md §5.8)
  return `${kind === 'cancel' ? '취소표 알림' : '오픈 알림'}을 ${on ? '신청하지' : '끄지'} 못했습니다. 잠시 뒤 다시 해 주세요`;
}
