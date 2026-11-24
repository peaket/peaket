// 회차 공연일 배포 값(docs/streaming.md §6.4 '보존', F-04-10 계획 §1.2).
// 사건 열에는 공연일이 없어 retain_until을 이 파일에서 정한다. 공연 날짜 정비 잡이 이 파일을 갱신한다.
import { readFileSync } from 'node:fs';
import { retainUntilOf } from './records.js';

export type EventDates = ReadonlyMap<string, string>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseEventDates(json: unknown): EventDates {
  const body = json as { events?: Record<string, string> } | Record<string, string>;
  const events = (body as { events?: Record<string, string> }).events ?? (body as Record<string, string>);
  const out = new Map<string, string>();
  for (const [eventId, date] of Object.entries(events)) {
    if (eventId === 'events') continue;
    if (typeof date !== 'string' || !DATE.test(date) || !retainUntilOf(date)) throw new Error(`공연일 모양이 틀렸다: ${eventId}=${String(date)}`);
    out.set(eventId, date);
  }
  return out;
}

export function fileEventDates(path: string): EventDates {
  return parseEventDates(JSON.parse(readFileSync(path, 'utf8')));
}

export function eventDatesFromEnv(env: Record<string, string | undefined>, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): EventDates {
  const inline = env.PEAKET_INV_EVENT_DATES;
  if (inline) return parseEventDates(JSON.parse(inline));
  const path = env.PEAKET_INV_EVENT_DATES_FILE;
  if (!path) throw new Error('PEAKET_INV_EVENT_DATES 또는 PEAKET_INV_EVENT_DATES_FILE이 없다');
  return parseEventDates(JSON.parse(readFile(path)));
}
