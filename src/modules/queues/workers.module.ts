import { Module } from '@nestjs/common';
import { QueuesModule } from './queues.module';
import { DispatchProcessor, AgentProcessor } from './dispatch.processor';
import { ReoptProcessor } from './reopt.processor';
import { NotifyProcessor } from './notify.processor';
import { OptimizationModule } from '../optimization/optimization.module';
import { AgentsModule } from '../agents/agents.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    QueuesModule,
    OptimizationModule,
    AgentsModule,
    NotificationsModule,
  ],
  providers: [
    DispatchProcessor,
    AgentProcessor,
    ReoptProcessor,
    NotifyProcessor,
  ],
})
export class WorkersModule {}
