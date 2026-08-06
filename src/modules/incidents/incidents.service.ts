import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IncidentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RegionsService } from '../regions/regions.service';
import { MetricsService } from '../metrics/metrics.service';
import { scorePriority } from '../optimization/priority.scorer';
import { QUEUE_DISPATCH, QUEUE_REOPT } from '../queues/queue.constants';
import { CreateIncidentDto, UpdateIncidentDto } from './dto/incident.dto';
import { KafkaService } from '../kafka/kafka.service';
import { KafkaTopics } from '../kafka/kafka.topics';

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regions: RegionsService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
    private readonly kafka: KafkaService,
    @InjectQueue(QUEUE_DISPATCH) private readonly dispatchQueue: Queue,
    @InjectQueue(QUEUE_REOPT) private readonly reoptQueue: Queue,
  ) {}

  async create(dto: CreateIncidentDto) {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.incident.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { assignments: true },
      });
      if (existing) return existing;
    }

    const maxDepth = this.config.get<number>('maxQueueDepth') || 5000;
    const depth = await this.dispatchQueue.count();
    if (depth > maxDepth) {
      throw new ServiceUnavailableException(
        'System overloaded — try again shortly (load shedding)',
      );
    }

    const region = await this.regions.resolveRegionId(dto.regionId);
    if (!region) throw new NotFoundException('Region not found');

    const envHazard = Number(
      (dto.environment as { hazard?: number } | undefined)?.hazard || 1,
    );
    const priorityScore = scorePriority({
      severity: dto.severity,
      affectedCount: dto.affectedCount ?? 1,
      timeSensitivity: dto.timeSensitivity ?? 3,
      environmentHazard: envHazard,
    });

    try {
      const incident = await this.prisma.incident.create({
        data: {
          regionId: region.id,
          title: dto.title,
          description: dto.description,
          lat: dto.lat,
          lng: dto.lng,
          severity: dto.severity,
          affectedCount: dto.affectedCount ?? 1,
          timeSensitivity: dto.timeSensitivity ?? 3,
          resourceNeeds: (dto.resourceNeeds || {
            types: ['AMBULANCE'],
          }) as Prisma.InputJsonValue,
          environment: (dto.environment || {}) as Prisma.InputJsonValue,
          disasterType: dto.disasterType,
          idempotencyKey: dto.idempotencyKey,
          priorityScore,
          status: IncidentStatus.PENDING,
        },
      });

      const priority = dto.severity >= 4 ? 1 : 5;
      await this.dispatchQueue.add(
        'dispatch',
        { incidentId: incident.id },
        {
          priority,
          removeOnComplete: 2000,
          removeOnFail: 1000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
      await this.metrics.incr('ingest.total');
      // Fan-out to Kafka AFTER durable write + BullMQ enqueue (fail-soft)
      void this.kafka.publish(
        KafkaTopics.INCIDENTS_CREATED,
        {
          id: incident.id,
          regionId: incident.regionId,
          title: incident.title,
          lat: incident.lat,
          lng: incident.lng,
          severity: incident.severity,
          affectedCount: incident.affectedCount,
          disasterType: incident.disasterType,
          priorityScore: incident.priorityScore,
          status: incident.status,
        },
        {
          key: incident.id,
          regionId: incident.regionId,
          idempotencyKey: incident.idempotencyKey || undefined,
          eventType: 'incident.created',
          source: 'incidents-service',
        },
      );
      await this.metrics.incr('kafka.publish.incidents');
      return incident;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.incident.findUnique({
          where: { idempotencyKey: dto.idempotencyKey! },
        });
        if (existing) return existing;
        throw new ConflictException('Duplicate incident');
      }
      throw err;
    }
  }

  findAll(status?: IncidentStatus) {
    return this.prisma.incident.findMany({
      where: status ? { status } : undefined,
      include: { assignments: true, region: true },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  findOne(id: string) {
    return this.prisma.incident.findUnique({
      where: { id },
      include: {
        assignments: { include: { resource: true } },
        agentRuns: {
          include: { steps: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        optimizationRuns: { orderBy: { createdAt: 'desc' }, take: 5 },
        region: true,
      },
    });
  }

  async agentRun(id: string) {
    return this.prisma.agentRun.findFirst({
      where: { incidentId: id },
      include: { steps: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, dto: UpdateIncidentDto) {
    const existing = await this.prisma.incident.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Incident not found');

    const severity = dto.severity ?? existing.severity;
    const priorityScore = scorePriority({
      severity,
      affectedCount: dto.affectedCount ?? existing.affectedCount,
      timeSensitivity: existing.timeSensitivity,
    });

    const updated = await this.prisma.incident.update({
      where: { id },
      data: {
        severity: dto.severity,
        affectedCount: dto.affectedCount,
        status: dto.status as IncidentStatus | undefined,
        priorityScore,
      },
    });

    if (dto.severity && dto.severity !== existing.severity) {
      await this.reoptQueue.add(
        'reopt',
        { regionId: existing.regionId, reason: `severity_change:${id}` },
        {
          jobId: `reopt-${existing.regionId}`,
          delay: 1000,
          removeOnComplete: 1000,
        },
      );
    }
    void this.kafka.publish(
      KafkaTopics.INCIDENTS_UPDATED,
      {
        id: updated.id,
        regionId: updated.regionId,
        severity: updated.severity,
        status: updated.status,
        priorityScore: updated.priorityScore,
      },
      {
        key: updated.id,
        regionId: updated.regionId,
        eventType: 'incident.updated',
      },
    );
    return updated;
  }
}
