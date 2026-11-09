// FE-T36 검사 시작 전: 지난 실행의 크기 기록(reports/sizes/)을 지운다
import { rmSync } from 'node:fs';

export default function setup() {
  rmSync(new URL('../reports/sizes/', import.meta.url), { recursive: true, force: true });
}
