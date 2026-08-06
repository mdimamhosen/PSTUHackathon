import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { SecurityModule } from './modules/security/security.module';
import { QueuesModule } from './modules/queues/queues.module';
import { MapsModule } from './modules/maps/maps.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { HealthModule } from './modules/health/health.module';
import { RegionsModule } from './modules/regions/regions.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { EventsModule } from './modules/events/events.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { OptimizationModule } from './modules/optimization/optimization.module';
import { RagModule } from './modules/rag/rag.module';
import { AgentsModule } from './modules/agents/agents.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SimulationModule } from './modules/simulation/simulation.module';
import { KafkaCoreModule } from './modules/kafka/kafka-core.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    SecurityModule,
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
    ResourcesModule,
    IncidentsModule,
    EventsModule,
    DispatchModule,
    SimulationModule,
    HealthModule,
  ],
})
export class AppModule {}
