// (console) 묶음 안에서 notFound()가 나면(없는 공연 등) 셸 안 본문만 그린다(SCR-059 404 변형).
// 본문은 ?state=를 읽는 클라이언트 부품이라 Suspense로 감싸고, 그동안은 기본 404 카드를 그린다.
import { Suspense } from 'react';
import { NoticeBody, NoticeView } from './NoticeBody';

export default function NotFoundInShell() {
  return (
    <Suspense fallback={<NoticeView state="404" />}>
      <NoticeBody kind="not-found" />
    </Suspense>
  );
}
