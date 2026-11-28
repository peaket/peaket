// BAT-455 시험·로컬 대역 전송기. 바깥으로 보내지 않고 보낸 것만 기록한다(BUILD_ORDER GAT-250 '로컬 대역').
import type { MailMessage, MailSendResult, MailTransport, PushSendInput, PushSendResult, PushTransport, SmsMessage, SmsSendResult, SmsTransport } from '../domain/fan-notify-ports.js';

export class FakeMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  readonly fail: Error[] = [];
  async send(input: MailMessage): Promise<MailSendResult> {
    const e = this.fail.shift();
    if (e) throw e;
    this.sent.push(input);
    return { providerMessageId: `fake-${this.sent.length}` };
  }
}

export class FakePushTransport implements PushTransport {
  readonly sent: PushSendInput[] = [];
  readonly responses: number[] = [];
  async send(input: PushSendInput): Promise<PushSendResult> {
    this.sent.push(input);
    return { status: this.responses.shift() ?? 201 };
  }
}

export class FakeSmsTransport implements SmsTransport {
  readonly sent?: SmsMessage[] = [];
  readonly fail?: Error[] = [];
  async send(input: SmsMessage): Promise<SmsSendResult> {
    const e = this.fail?.shift();
    if (e) throw e;
    this.sent?.push(input);
    return { providerMessageId: `sms-${this.sent?.length ?? 0}` };
  }
}

/** 설정이 없을 때: 보내지 않고 영구 실패로 남긴다(운영 대행 계약 전) */
export const unavailableMail: MailTransport = {
  send: async () => {
    throw new Error('메일 대행이 조립되지 않았습니다');
  },
};

export const unavailablePush: PushTransport = {
  send: async () => {
    throw new Error('웹 푸시 전송기가 조립되지 않았습니다');
  },
};

/** 설정이 없을 때: 보내지 않고 영구 실패로 남긴다(운영 문자 대행 계약 전) */
export const unavailableSms: SmsTransport = {
  send: async () => {
    throw new Error('문자 대행이 조립되지 않았습니다');
  },
};
