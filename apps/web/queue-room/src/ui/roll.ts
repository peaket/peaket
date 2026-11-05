// ① 앞 인원 숫자 굴림(d5 §5.8 lg '숫자를 굴리는 모션(base)'). 바뀐 자리만 앞 글자를 함께 두어 위에서 내려오게 굴린다.
// 자릿수가 바뀌면 오른쪽 끝(일의 자리)을 맞춰 견주고, 새로 생긴 자리는 빈 글자에서 굴린다. 움직임 줄이기·저전력은 CSS가 효과를 끈다.

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
