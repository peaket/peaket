// 앞 인원 숫자 굴림의 자리 견주기(d5 §5.8 lg, ADR-0213 결정 6). 대기실 apps/web/queue-room/src/ui/roll.ts와 같은 규칙이고
// roll.test.mjs가 둘의 결과가 같은지 본다. 바뀐 자리만 앞 글자를 함께 두고, 자릿수가 바뀌면 오른쪽 끝을 맞추며, 새로 생긴 자리는 빈 글자에서 굴린다.

export interface RollDigit {
  ch: string;
  /** 있으면 이 자리가 바뀌었다(앞 글자, 새로 생긴 자리는 '') */
  old?: string;
}

export function rollDigits(now: string, before: string | undefined): RollDigit[] {
  const shift = before === undefined ? 0 : before.length - now.length;
  return [...now].map((ch, i) => {
    if (before === undefined) return { ch };
    const j = i + shift;
    const old = j >= 0 && j < before.length ? before[j]! : '';
    return old === ch ? { ch } : { ch, old };
  });
}
