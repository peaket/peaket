// 인증 앱 등록 QR의 그림(보드 SCR-020 qrCells와 같은 결정적 무늬, 29×29). 실제 QR이 아니라 모양만 옮긴 근사다(design.md 결정 8).
// 실제 등록 QR은 데이터를 잇는 단계에서 서버가 준 otpauth 값으로 그린다.
export function qrCells(seed: number): boolean[] {
  const n = 29;
  let s = seed;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const out: boolean[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let on: boolean;
      const fr = r < 7 ? r : r >= n - 7 ? r - (n - 7) : -1;
      const fc = c < 7 ? c : c >= n - 7 ? c - (n - 7) : -1;
      const finder = fr >= 0 && fc >= 0 && !(r >= n - 7 && c >= n - 7);
      const sep = !finder && ((r <= 7 && c <= 7) || (r <= 7 && c >= n - 8) || (r >= n - 8 && c <= 7));
      if (finder) on = fr === 0 || fr === 6 || fc === 0 || fc === 6 || (fr >= 2 && fr <= 4 && fc >= 2 && fc <= 4);
      else if (sep) on = false;
      else if (r === 6) on = c % 2 === 0;
      else if (c === 6) on = r % 2 === 0;
      else if (r >= 20 && r <= 24 && c >= 20 && c <= 24) {
        const ar = r - 20;
        const ac = c - 20;
        on = ar === 0 || ar === 4 || ac === 0 || ac === 4 || (ar === 2 && ac === 2);
      } else on = rnd() > 0.52;
      out.push(on);
    }
  }
  return out;
}
