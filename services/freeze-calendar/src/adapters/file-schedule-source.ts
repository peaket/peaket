// 로컬·시험용 일정 원천. 운영은 S3ScheduleSource를 쓴다(구간 5에서 버킷·권한을 붙인다).
import { readFile } from 'node:fs/promises';
import type { ScheduleSource } from '../calendar.js';

export class FileScheduleSource implements ScheduleSource {
  constructor(private readonly file: string) {}

  async read(): Promise<{ text: string }> {
    return { text: await readFile(this.file, 'utf8') };
  }
}
