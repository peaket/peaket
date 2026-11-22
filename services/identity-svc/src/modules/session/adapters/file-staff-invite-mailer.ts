// local·ci 현장 스태프 초대 메일 대역(BUILD_ORDER BAT-450B, identity §6.1, ADR-0353).
// PEAKET_STAFF_MAIL_DIR 폴더의 staff-invite-mail.jsonl에 한 줄씩 쓴다(FileAdminMailer와 같은 꼴, 저장소에 넣지 않는다).
// 운영 이메일 대행사 어댑터는 GAT-250/BAT-455로 넘긴다.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_STAFF_INVITATION_URL, type StaffInviteMail, type StaffInviteMailer } from '../domain/staff.js';

export const STAFF_MAIL_DIR_ENV = 'PEAKET_STAFF_MAIL_DIR';
export const STAFF_MAIL_FILE = 'staff-invite-mail.jsonl';

export class FileStaffInviteMailer implements StaffInviteMailer {
  constructor(private readonly dir: string) {}

  async send(m: StaffInviteMail): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, STAFF_MAIL_FILE), `${JSON.stringify({ ...m, at: new Date(m.at).toISOString() })}\n`, 'utf8');
  }
}

/** local·ci에서 폴더 설정이 있으면 파일 대역, 아니면 null(초대 만들기·재발송이 503이다) */
export function staffInviteMailerFromEnv(env: Record<string, string | undefined>): StaffInviteMailer | null {
  const dir = env[STAFF_MAIL_DIR_ENV];
  if (!dir) return null;
  if (!['local', 'ci'].includes(env.PEAKET_ENV ?? 'prod')) throw new Error(`${STAFF_MAIL_DIR_ENV}(초대 메일 대역)는 local·ci에서만 쓴다`);
  return new FileStaffInviteMailer(dir);
}

/** 초대 링크 앞부분. 조각(#token=)은 부르는 쪽이 붙인다. 경로·질의·조각이 있으면 시작을 막는다 */
export function staffInvitationUrlFromEnv(env: Record<string, string | undefined>): string {
  const raw = env.PEAKET_STAFF_INVITATION_URL?.trim();
  if (!raw) return DEFAULT_STAFF_INVITATION_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PEAKET_STAFF_INVITATION_URL이 URL이 아니다: ${raw}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash || url.username || url.password) {
    throw new Error(`PEAKET_STAFF_INVITATION_URL은 쿼리·조각·사용자 정보가 없는 http(s) 주소여야 한다: ${raw}`);
  }
  return raw.replace(/\/+$/, '');
}
