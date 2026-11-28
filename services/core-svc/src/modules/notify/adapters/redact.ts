// F-06-6 GAT-250 대행사 오류·로그 비밀 지우기. Authorization 머리와 설정 비밀 값을 [redacted]로 바꾼다.
export function redactProviderText(text: string, secrets: readonly string[]): string {
  let out = text.replace(/Authorization:[^\n\r]*/gi, 'Authorization: [redacted]');
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/signature=\S+/gi, 'signature [redacted]');
  return out;
}
