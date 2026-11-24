// 로컬·시험용 달력 원천. 운영은 ArgoCD가 마운트한 ConfigMap 파일을 읽는다(구간 5).
import { readFile } from 'node:fs/promises';
import type { FreezeCalendar } from '../calendar.js';
import type { FreezeCalendarSource } from '../guard.js';

export class FileCalendarSource implements FreezeCalendarSource {
  constructor(private readonly file: string) {}

  async read(): Promise<FreezeCalendar> {
    return JSON.parse(await readFile(this.file, 'utf8')) as FreezeCalendar;
  }
}
