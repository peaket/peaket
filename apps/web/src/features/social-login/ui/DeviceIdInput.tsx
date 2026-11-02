'use client';
// 로그인 시작 폼의 숨은 칸 deviceId(docs/features/identity.md §2 '웹 앱 서버 경로'). 화면이 그려진 뒤 localStorage에서 채운다.
// 스크립트가 돌지 않으면 비어 있고, 앱 서버는 기기 행 없이 세션을 만든다.
import { useEffect, useRef } from 'react';
import { deviceId } from '@/shared/lib/device-id';

export function DeviceIdInput() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.value = deviceId() ?? '';
  }, []);
  return <input ref={ref} type="hidden" name="deviceId" defaultValue="" />;
}
