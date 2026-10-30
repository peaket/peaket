// 화면 목록(/preview) 등록 항목 형식. ds PreviewScreen(SCR·이름·경로 예시·상태 목록)에 경로 묶음과 담당을 더했다.
import type { PreviewScreen } from '@peaket/ds/Preview';

/** 경로 묶음: cached(헤더 묶음 A) · request(B·E·F) · queue-room(대기실 경량 페이지, 포트 3004) · interstitial(끼어드는 화면·시스템 안내) */
export type ScreenGroup = 'cached' | 'request' | 'queue-room' | 'interstitial';
/** 담당: skeleton(골격) · discovery · account · booking · queue-room(대기실) */
export type ScreenOwner = 'skeleton' | 'discovery' | 'account' | 'booking' | 'queue-room';

export interface WebScreen extends PreviewScreen {
  group: ScreenGroup;
  owner: ScreenOwner;
}

export const GROUP_LABEL: Record<ScreenGroup, string> = {
  cached: '(cached) 묶음 A',
  request: '(request) 묶음 B·E·F',
  'queue-room': '대기실 경량 페이지(3004)',
  interstitial: '끼어드는 화면·시스템 안내',
};
