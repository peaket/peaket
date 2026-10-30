'use client';
// SCR-009 ⑤ 설명 요청·재검토 신청(d5 §5.9 ⑤, ADR-0062). 내용은 0~1,000자(grapheme, ds TextArea가 센다).
// 비워 보내면 설명 요청, 쓰면 설명과 재검토. 버튼은 하나다. 퍼블리싱에서는 보내면 '재검토 접수' 상태로 넘어간다(서버 연결 없음).
// 버튼: 휴대폰 52 줄 폭 · 태블릿 52 왼쪽 정렬 · 데스크톱 40 왼쪽 정렬(보드 m·t·d).
import { useRouter } from 'next/navigation';
import { TextArea } from '@peaket/ds/TextArea';

export function AppealForm({ submittedHref }: { submittedHref: string }) {
  const router = useRouter();
  return (
    <form
      className="col"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        router.push(submittedHref, { scroll: false });
      }}
    >
      <TextArea id="ap-text" name="appeal" label="내용" maxLength={1000} hint="건강 정보 같은 민감한 내용은 적지 않아도 됩니다" />
      <button
        className="btn btn-secondary btn-lg btn-block md:w-auto md:self-start lg:min-h-10 lg:rounded-(--r-md) lg:px-4 lg:text-sm lg:leading-[19px]"
        type="submit"
      >
        재검토 신청하기
      </button>
    </form>
  );
}
