// 없는 주소(앱 뿌리의 not-found, SCR-059 404 변형): (console) 묶음 밖이라 셸을 직접 두른다.
// 화면 목록의 /system-notice-preview가 이 화면이고, ?state=로 다른 변형(500·429·미지원)을 고른다.
import { Suspense } from 'react';
import { ShellFrame } from '@/widgets/partner-shell';
import { NoticeBody } from './NoticeBody';

export default function NotFoundPage() {
  return (
    <Suspense>
      <ShellFrame>
        <NoticeBody kind="not-found" />
      </ShellFrame>
    </Suspense>
  );
}
