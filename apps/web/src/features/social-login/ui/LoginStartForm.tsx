// 로그인 시작 폼(POST /login/{provider}, docs/features/identity.md §2). 버튼을 누를 때만 로그인을 시작하고(SCR-004), 지금 창에서 제공자로 이동한다(ADR-0119).
// 돌아갈 주소는 /login?next=의 값이고 앱 서버가 같은 출처 경로인지 다시 본다(asvs/auth.md 3.7.2).
// onSubmit은 화면의 '진행 중' 표시용이다. 폼은 보내는 동안 문서에 남아 있어야 한다(빠지면 브라우저가 보내기를 취소한다).
import type { FormEvent, ReactNode } from 'react';
import { DeviceIdInput } from './DeviceIdInput';

export function LoginStartForm({
  provider,
  returnTo,
  onSubmit,
  children,
}: {
  provider: string;
  returnTo: string;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  return (
    <form method="post" action={`/login/${provider}`} onSubmit={onSubmit}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <DeviceIdInput />
      {children}
    </form>
  );
}
