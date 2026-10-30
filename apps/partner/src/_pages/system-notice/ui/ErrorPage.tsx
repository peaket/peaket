'use client';
// (console) 묶음의 오류 경계(Next.js error.tsx는 클라이언트 부품이어야 한다). 셸 안 본문만 그린다(SCR-059 500 변형).
// 오류 내용(메시지·digest)은 화면에 보이지 않는다(d5 §5.33, ASVS 16.5.1).
import { NoticeBody } from './NoticeBody';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <NoticeBody kind="error" onRetry={reset} />;
}
