// F-06-8 Amazon SES 이메일 어댑터(ADR-0387). 서울 리전을 코드에 고정하고, 자격 증명은 Pod Identity 기본 사슬만 쓴다.
// local·ci·demo는 FakeMailTransport를 쓰고, 이 어댑터는 실제 발송이 허용된 운영에서만 조립한다(이번 가지는 실제 발송 미실행).
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import type { MailMessage, MailSendResult, MailTransport } from '../domain/fan-notify-ports.js';

/** 서울 리전. 다른 리전으로 바꾸지 않는다(ADR-0387 결정 1) */
export const SES_REGION = 'ap-northeast-2';

export interface SesMailTransportOptions {
  /** 예: `피켓 <no-reply@notify.peaket.example>`. 실제 도메인은 소유자 몫 */
  from: string;
  /** 고객센터 주소 */
  replyTo: string;
  /** configuration set `peaket-notify`(SES SNS 결과 받기, F-06-9) */
  configurationSet?: string;
  /** 시험에서 흉내 클라이언트를 넣는다 */
  client?: SESClient;
}

export class SesMailTransport implements MailTransport {
  readonly #client: SESClient;
  constructor(private readonly o: SesMailTransportOptions) {
    this.#client = o.client ?? new SESClient({ region: SES_REGION });
  }

  async send(input: MailMessage): Promise<MailSendResult> {
    const command = new SendEmailCommand({
      Source: this.o.from,
      Destination: { ToAddresses: [input.to] },
      ReplyToAddresses: [this.o.replyTo],
      ...(this.o.configurationSet ? { ConfigurationSetName: this.o.configurationSet } : {}),
      Message: {
        Subject: { Data: input.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: input.body, Charset: 'UTF-8' },
          ...(input.html !== undefined ? { Html: { Data: input.html, Charset: 'UTF-8' } } : {}),
        },
      },
    });
    const result = await this.#client.send(command);
    return { ...(result.MessageId !== undefined ? { providerMessageId: result.MessageId } : {}) };
  }
}

/** 운영 환경 값에서 SES 어댑터를 만든다. 하나라도 없으면 undefined(호출부가 파일 대역·가짜를 고른다) */
export function sesMailTransportFromEnv(env: Record<string, string | undefined>): SesMailTransport | undefined {
  const from = env.PEAKET_NOTIFY_MAIL_FROM?.trim();
  const replyTo = env.PEAKET_NOTIFY_MAIL_REPLY_TO?.trim();
  if (!from || !replyTo) return undefined;
  return new SesMailTransport({
    from,
    replyTo,
    ...(env.PEAKET_NOTIFY_SES_CONFIGURATION_SET?.trim() ? { configurationSet: env.PEAKET_NOTIFY_SES_CONFIGURATION_SET.trim() } : {}),
  });
}
