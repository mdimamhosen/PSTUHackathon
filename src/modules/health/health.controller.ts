import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  QUEUE_DISPATCH,
  QUEUE_REOPT,
  QUEUE_NOTIFY,
} from '../queues/queue.constants';
import { MapsService } from '../maps/maps.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly maps: MapsService,
    @InjectQueue(QUEUE_DISPATCH) private readonly dispatchQueue: Queue,
    @InjectQueue(QUEUE_REOPT) private readonly reoptQueue: Queue,
    @InjectQueue(QUEUE_NOTIFY) private readonly notifyQueue: Queue,
  ) {}

  @Public()
  @Get()
  async check() {
    let dbOk = false;
    let redisOk = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    try {
      const counts = await Promise.all([
        this.dispatchQueue.getWaitingCount(),
        this.reoptQueue.getWaitingCount(),
        this.notifyQueue.getWaitingCount(),
      ]);
      redisOk = counts.every((c) => Number.isFinite(c));
    } catch {
      redisOk = false;
    }

    const depths = {
      dispatch: await this.dispatchQueue.count(),
      reopt: await this.reoptQueue.count(),
      notify: await this.notifyQueue.count(),
    };

    const status = dbOk && redisOk ? 'ok' : 'degraded';
    return {
      status,
      db: dbOk,
      redis: redisOk,
      queueDepths: depths,
      integrations: {
        googleMaps: {
          configured: !!this.config.get('googleMapsApiKey'),
          circuit: this.maps.circuitStatus(),
        },
        anthropic: { configured: !!this.config.get('anthropicApiKey') },
        openai: { configured: !!this.config.get('openaiApiKey') },
        telegram: {
          configured: !!(
            this.config.get('telegramBotToken') &&
            this.config.get('telegramEocChatId')
          ),
        },
        smtp: { configured: !!this.config.get('smtp.host') },
        twilio: {
          configured: !!(
            this.config.get('twilio.accountSid') &&
            this.config.get('twilio.authToken')
          ),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }
}
