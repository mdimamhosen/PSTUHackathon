import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as nodemailer from 'nodemailer';
import { CircuitBreaker } from '../../common/utils/circuit-breaker';
import { MetricsService } from '../metrics/metrics.service';

export type AlertPayload = {
  title: string;
  body: string;
  severity?: number;
  incidentId?: string;
  email?: string | null;
  telegramChatId?: string | null;
  phone?: string | null;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly telegramBreaker = new CircuitBreaker(3, 30_000);
  private readonly emailBreaker = new CircuitBreaker(3, 30_000);

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async sendAlert(payload: AlertPayload) {
    const results = {
      telegram: false,
      email: false,
      sms: false,
    };
    const chatId =
      payload.telegramChatId || this.config.get<string>('telegramEocChatId');
    if (this.config.get('telegramBotToken') && chatId) {
      results.telegram = await this.sendTelegram(chatId, payload);
    }
    if (this.config.get('smtp.host') && (payload.email || true)) {
      results.email = await this.sendEmail(payload);
    }
    if (
      this.config.get('twilio.accountSid') &&
      this.config.get('twilio.authToken') &&
      payload.phone
    ) {
      results.sms = await this.sendSms(payload);
    }
    await this.metrics.incr('notify.total');
    return results;
  }

  private async sendTelegram(chatId: string, payload: AlertPayload) {
    const token = this.config.get<string>('telegramBotToken');
    return this.telegramBreaker.exec(
      async () => {
        await axios.post(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            chat_id: chatId,
            text: `🚨 ${payload.title}\n\n${payload.body}${
              payload.incidentId ? `\n\nIncident: ${payload.incidentId}` : ''
            }`,
          },
          { timeout: 5000 },
        );
        return true;
      },
      async () => {
        this.logger.warn('Telegram alert skipped/failed');
        return false;
      },
    );
  }

  private async sendEmail(payload: AlertPayload) {
    const host = this.config.get<string>('smtp.host');
    if (!host) return false;
    return this.emailBreaker.exec(
      async () => {
        const transporter = nodemailer.createTransport({
          host,
          port: this.config.get<number>('smtp.port'),
          secure: false,
          auth: {
            user: this.config.get<string>('smtp.user'),
            pass: this.config.get<string>('smtp.pass'),
          },
        });
        await transporter.sendMail({
          from: this.config.get<string>('smtp.from'),
          to: payload.email || this.config.get<string>('smtp.user'),
          subject: `[Emergency] ${payload.title}`,
          text: payload.body,
        });
        return true;
      },
      async () => {
        this.logger.warn('Email alert skipped/failed');
        return false;
      },
    );
  }

  private async sendSms(payload: AlertPayload) {
    try {
      const sid = this.config.get<string>('twilio.accountSid');
      const token = this.config.get<string>('twilio.authToken');
      const from = this.config.get<string>('twilio.fromNumber');
      const auth = Buffer.from(`${sid}:${token}`).toString('base64');
      const body = new URLSearchParams({
        To: payload.phone!,
        From: from!,
        Body: `${payload.title}: ${payload.body}`.slice(0, 300),
      });
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        body.toString(),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 5000,
        },
      );
      return true;
    } catch {
      this.logger.warn('SMS alert skipped/failed');
      return false;
    }
  }
}
