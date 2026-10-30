// 클래스 이름 합치기. 거짓 값은 빠진다.
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
