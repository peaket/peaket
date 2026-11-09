// K5 PoC 준비: 5만 석 열 단위 배치 파일을 page/gen/layout.json에 만들고, 미리 압축한 짝 layout.json.br(brotli 11)을 둔다
// (정적 서버가 Accept-Encoding: br이면 Content-Encoding: br로 준다). 두 형식의 크기를 reports/seatmap/sizes.json에 남긴다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateLayout, toObjectLayout, sizes, brotli } from './layout.mjs';

export default function setup() {
  const layout = generateLayout();
  const columns = JSON.stringify(layout);
  const objects = JSON.stringify(toObjectLayout(layout));
  mkdirSync(new URL('./page/gen/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./page/gen/layout.json', import.meta.url), columns);
  writeFileSync(new URL('./page/gen/layout.json.br', import.meta.url), brotli(columns));
  mkdirSync(new URL('../reports/seatmap/', import.meta.url), { recursive: true });
  writeFileSync(
    new URL('../reports/seatmap/sizes.json', import.meta.url),
    `${JSON.stringify({ seats: layout.seatCount, columns: sizes(columns), objects: sizes(objects) }, null, 2)}\n`,
  );
}
