// 오픈 알림 신청·끄기 실패 문구: 오류 이름(type)으로 고른다(docs/frontend.md §4.1 '오류 모양'). 홈(HOT-300)과 공연 상세(HOT-311)가 같이 쓴다.
import { problemName } from '@/shared/api/refresh';

export function alertFailureText(e: unknown, on: boolean): string {
  const type = problemName(e);
  if (type === 'open-passed') return '오픈 시각이 지나 오픈 알림을 신청할 수 없습니다';
  if (type === 'subscription-limit') return '알림 신청 수를 넘었습니다. 관심 공연에서 쓰지 않는 알림을 꺼 주세요';
  return on ? '오픈 알림을 신청하지 못했습니다. 잠시 뒤 다시 해 주세요' : '오픈 알림을 끄지 못했습니다. 잠시 뒤 다시 해 주세요';
}
