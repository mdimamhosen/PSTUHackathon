import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  QUEUE_AGENT,
  QUEUE_DISPATCH,
  QUEUE_NOTIFY,
  QUEUE_REOPT,
} from './queue.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('redisUrl') || 'redis://localhost:6379',
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_DISPATCH },
      { name: QUEUE_REOPT },
      { name: QUEUE_NOTIFY },
      { name: QUEUE_AGENT },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
