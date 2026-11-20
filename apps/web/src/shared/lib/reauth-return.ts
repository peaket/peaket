// 소비자 웹 앱 서버의 재인증 왕복(identity §7.1): POST /reauth/{provider} 양식을 이 창에서 보내고,
// 돌아온 뒤 POST /reauth/token으로 토큰을 한 번 받는다. 둘 다 같은 출처(앱 서버)라 API 클라이언트가 아니라 fetch를 쓴다.
// 토큰은 메모리에만 두고 부르는 화면이 요청 머리(X-Reauth-Token)에 한 번 쓴다. 저장소·주소·로그에 남기지 않는다.
import { reauthFailureOf, type ReauthFailure } from './reauth-failure';

export type ReauthPickup = { kind: 'token'; token: string } | { kind: 'failed'; reason: ReauthFailure };

/** 재인증 시작 양식을 이 창에서 제출한다. purpose는 그 작업의 웹 값이고, returnTo는 끝나고 돌아올 같은 출처 경로다 */
export function submitReauthForm(provider: string, returnTo: string, purpose: string): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = `/reauth/${encodeURIComponent(provider)}`;
  form.hidden = true;
  for (const [name, value] of Object.entries({ returnTo, purpose })) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

/** 문제 type의 끝 이름. 읽지 못하면 '' */
async function problemTypeOf(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * 돌아온 뒤 재인증 결과를 한 번 받는다(200 `{reauthToken}`). 실패는 이유별 문구로 가른다.
 * 연결 끊김·모양 오류는 `failed`로 보아 다시 인증하게 한다(토큰을 잃은 것과 같다).
 */
export async function pickupReauthToken(fetchImpl: typeof fetch = fetch): Promise<ReauthPickup> {
  let r: Response;
  try {
    r = await fetchImpl('/reauth/token', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return { kind: 'failed', reason: 'failed' };
  }
  if (r.status === 200) {
    try {
      const b = (await r.json()) as { reauthToken?: unknown };
      return typeof b.reauthToken === 'string' && b.reauthToken ? { kind: 'token', token: b.reauthToken } : { kind: 'failed', reason: 'failed' };
    } catch {
      return { kind: 'failed', reason: 'failed' };
    }
  }
  return { kind: 'failed', reason: reauthFailureOf(await problemTypeOf(r)) };
}
