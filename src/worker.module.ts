import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { QueuesModule } from './modules/queues/queues.module';
import { WorkersModule } from './modules/queues/workers.module';
import { MapsModule } from './modules/maps/maps.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { OptimizationModule } from './modules/optimization/optimization.module';
import { RagModule } from './modules/rag/rag.module';
import { AgentsModule } from './modules/agents/agents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    QueuesModule,
    MapsModule,
    MetricsModule,
    RealtimeModule,
    OptimizationModule,
    NotificationsModule,
    RagModule,
    AgentsModule,
    WorkersModule,
  ],
})
export class WorkerModule {}
