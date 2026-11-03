// 로그인 시작 폼(POST /login/{provider}, docs/features/identity.md §2). 버튼을 누를 때만 로그인을 시작하고(SCR-004), 지금 창에서 제공자로 이동한다(ADR-0119).
// 돌아갈 주소는 /login?next=의 값이고 앱 서버가 같은 출처 경로인지 다시 본다(asvs/auth.md 3.7.2).
import type { ReactNode } from 'react';
import { DeviceIdInput } from './DeviceIdInput';

export function LoginStartForm({ provider, returnTo, children }: { provider: string; returnTo: string; children: ReactNode }) {
  return (
    <form method="post" action={`/login/${provider}`}>
      <input type="hidden" name="returnTo" value={returnTo} />
      <DeviceIdInput />
      {children}
    </form>
  );
}
