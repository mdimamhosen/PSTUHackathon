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
import { KafkaCoreModule } from './modules/kafka/kafka-core.module';
import { KafkaIngressModule } from './modules/kafka/kafka-ingress.module';
import { RegionsModule } from './modules/regions/regions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    QueuesModule,
    KafkaCoreModule,
    MapsModule,
    MetricsModule,
    RealtimeModule,
    OptimizationModule,
    NotificationsModule,
    RagModule,
    AgentsModule,
    RegionsModule,
    WorkersModule,
    // Real-time region gateway ingest via Kafka
    KafkaIngressModule,
  ],
})
export class WorkerModule {}
