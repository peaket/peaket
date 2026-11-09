'use client';
// 로그인 시작 폼의 숨은 칸 deviceId(docs/features/identity.md §2 '웹 앱 서버 경로'). 하이드레이션 뒤 localStorage 값으로 그린다.
// 스크립트가 돌지 않으면 비어 있고, 앱 서버는 기기 행 없이 세션을 만든다.
// 값은 그리는 값(value)으로 든다. 예전처럼 defaultValue=""에 효과로 넣으면, 숨은 칸은 value가 곧 기본값이라 누른 뒤 '진행 중'으로
// 다시 그릴 때 React가 기본값을 ""로 되돌려 빈 값이 나갔다(갈래 3 BOT-044 재현, tools/web-checks/csp/login.spec.mjs)
import { useSyncExternalStore } from 'react';
import { deviceId } from '@/shared/lib/device-id';

const noop = () => () => undefined;

export function DeviceIdInput() {
  // 서버와 첫 하이드레이션은 빈 값, 그 뒤는 저장소 값(처음 쓸 때 만들고 그 뒤로는 같은 값이다)
  const value = useSyncExternalStore(noop, () => deviceId() ?? '', () => '');
  return <input type="hidden" name="deviceId" value={value} />;
}
