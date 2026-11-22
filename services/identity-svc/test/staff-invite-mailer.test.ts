// 현장 스태프 초대 메일의 local·ci 파일 대역 시험(BUILD_ORDER BAT-450B, identity §6.1, ADR-0353).
// FileAdminMailer와 같은 꼴이다. 운영 대행사 어댑터는 GAT-250/BAT-455로 넘기고, 이 묶음은 포트와 파일 대역만 본다.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileStaffInviteMailer, STAFF_MAIL_DIR_ENV, staffInviteMailerFromEnv } from '../src/modules/session/adapters/file-staff-invite-mailer.js';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'peaket-staff-mail-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('FileStaffInviteMailer [BAT-450B]', () => {
  test('I-T21 ⑥ 파일 한 줄에 수신자·조각 링크·만료·회차·역할·시각을 남긴다', async () => {
    const dir = await tempDir();
    const mailer = new FileStaffInviteMailer(dir);
    const link = 'https://peaket.example/staff/invitations#token=abc_DEF-123';
    await mailer.send({ to: 'staff@example.com', link, expiresAt: 1_700_000_000_000, eventId: 'ev-1', role: 'gate_lead', at: 1_699_900_000_000 });
    const lines = (await readFile(join(dir, 'staff-invite-mail.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      to: 'staff@example.com',
      link,
      expiresAt: 1_700_000_000_000,
      eventId: 'ev-1',
      role: 'gate_lead',
      at: new Date(1_699_900_000_000).toISOString(),
    });
    expect(JSON.parse(lines[0]!).link).toContain('#token=');
    expect(JSON.parse(lines[0]!).link).not.toContain('?token=');
  });

  test('I-T21 ⑥ 두 통을 보내면 두 줄이고, 폴더가 없으면 만든다', async () => {
    const dir = join(await tempDir(), 'nested', 'mail');
    const mailer = new FileStaffInviteMailer(dir);
    await mailer.send({ to: 'a@example.com', link: 'https://peaket.example/staff/invitations#token=a', expiresAt: 2, eventId: 'ev', role: 'gate_staff', at: 1 });
    await mailer.send({ to: 'b@example.com', link: 'https://peaket.example/staff/invitations#token=b', expiresAt: 2, eventId: 'ev', role: 'gate_staff', at: 1 });
    const lines = (await readFile(join(dir, 'staff-invite-mail.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).to)).toEqual(['a@example.com', 'b@example.com']);
  });

  test('I-T21 ⑥ 설정이 없으면 null, local·ci 밖이면 시작하지 않는다', async () => {
    const dir = await tempDir();
    expect(staffInviteMailerFromEnv({ PEAKET_ENV: 'ci' })).toBeNull();
    expect(staffInviteMailerFromEnv({ PEAKET_ENV: 'ci', [STAFF_MAIL_DIR_ENV]: dir })).toBeInstanceOf(FileStaffInviteMailer);
    expect(staffInviteMailerFromEnv({ PEAKET_ENV: 'local', [STAFF_MAIL_DIR_ENV]: dir })).toBeInstanceOf(FileStaffInviteMailer);
    expect(() => staffInviteMailerFromEnv({ PEAKET_ENV: 'prod', [STAFF_MAIL_DIR_ENV]: dir })).toThrow(/local·ci/);
    expect(() => staffInviteMailerFromEnv({ [STAFF_MAIL_DIR_ENV]: dir })).toThrow(/local·ci/);
  });
});
