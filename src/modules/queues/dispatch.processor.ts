import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ResourceMatcher } from '../optimization/resource.matcher';
import { AgentsService } from '../agents/agents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_AGENT, QUEUE_DISPATCH, QUEUE_NOTIFY } from './queue.constants';

@Processor(QUEUE_DISPATCH, { concurrency: 8 })
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(
    private readonly matcher: ResourceMatcher,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue(QUEUE_AGENT) private readonly agentQueue: Queue,
    @InjectQueue(QUEUE_NOTIFY) private readonly notifyQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ incidentId: string }>) {
    const { incidentId } = job.data;
    this.logger.log(`Hot-path dispatch for ${incidentId}`);
    const result = await this.matcher.assignForIncident(incidentId, 'dispatch');
    const incident = await this.prisma.incident.findUnique({
      where: { id: incidentId },
      include: { region: true, assignments: true },
    });
    if (incident) {
      this.realtime.emitAssignment(incident.regionId, incidentId, {
        incidentId,
        assignments: result.assignments,
        latencyMs: result.latencyMs,
      });
      await this.agentQueue.add(
        'agent',
        { incidentId },
        { removeOnComplete: 1000, removeOnFail: 500 },
      );
      if (incident.severity >= 4) {
        await this.notifyQueue.add(
          'alert',
          {
            title: `Critical incident ${incident.title}`,
            body: `Severity ${incident.severity}, affected ${incident.affectedCount}. Assignments: ${result.assignments.length}`,
            severity: incident.severity,
            incidentId,
            email: incident.region.eocEmail,
            telegramChatId: incident.region.telegramChatId,
          },
          { removeOnComplete: 1000 },
        );
      }
    }
    return result;
  }
}

@Processor(QUEUE_AGENT, { concurrency: 4 })
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(private readonly agents: AgentsService) {
    super();
  }

  async process(job: Job<{ incidentId: string }>) {
    this.logger.log(`Cold-path agents for ${job.data.incidentId}`);
    return this.agents.runForIncident(job.data.incidentId);
  }
}
