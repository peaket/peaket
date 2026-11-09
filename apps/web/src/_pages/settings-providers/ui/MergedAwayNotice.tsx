'use client';
// 실제 계정 합치기에서 지금 계정이 흡수된 뒤 여는 주소(?ended=MERGED, features/login-methods MERGED_AWAY_PATH)의 화면.
// 서버는 세션 종료 사유를 화면에 알려 주지 않아(갱신 401은 사유 없음) 주소만 믿고 흡수 안내를 그리지 않는다.
// 방금 흡수 확정을 받은 이 탭이 남긴 표시(탭 저장소 peaket.providers.merged, 1분)가 있을 때만 안내를 보이고, 없으면 ?ended=를 뺀 로그인 수단 화면으로 간다
// (docs/features/identity.md §2.1 '계정 병합의 첫 구현' 화면, d5 §5.22 '지금 계정이 흡수됨', BOT-043이 넘긴 것).
import { useEffect, useRef, useState } from 'react';
import { RETURN_TO as PROVIDERS_PATH, tabStore, takeMergedAway } from '@/features/login-methods';
import { Absorbed } from './Absorbed';

export function MergedAwayNotice() {
  const [shown, setShown] = useState(false);
  // 표시는 처음 읽을 때 지우므로, 개발 모드 StrictMode가 효과를 두 번 돌려도 한 번만 읽는다(본인확인 흐름의 복귀 건과 같다)
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    if (takeMergedAway(tabStore, Date.now())) setShown(true);
    else window.location.replace(PROVIDERS_PATH);
  }, []);
  if (!shown) return <div className="spinner m-auto my-8" role="status" aria-label="불러오는 중" />;
  return <Absorbed live />;
}
