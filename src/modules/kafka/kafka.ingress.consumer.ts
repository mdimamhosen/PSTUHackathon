import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaService } from './kafka.service';
import { KafkaConsumerGroups, KafkaTopics } from './kafka.topics';
import { IncidentsService } from '../incidents/incidents.service';
import { EventsService } from '../events/events.service';
import { ResourcesService } from '../resources/resources.service';
import { EnvironmentEventType, ResourceType } from '@prisma/client';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Real-time ingress: region gateways → Kafka → same domain services as HTTP.
 * Keeps BullMQ hot-path assign intact (IncidentsService.create still enqueues dispatch).
 */
@Injectable()
export class KafkaIngressConsumer implements OnModuleInit {
  private readonly logger = new Logger(KafkaIngressConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly incidents: IncidentsService,
    private readonly events: EventsService,
    private readonly resources: ResourcesService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit() {
    if (!this.kafka.isEnabled) return;

    await this.kafka.subscribe(
      KafkaConsumerGroups.INGRESS,
      [
        KafkaTopics.INCIDENTS_INGRESS,
        KafkaTopics.ENVIRONMENT_INGRESS,
        KafkaTopics.RESOURCES_INGRESS,
      ],
      async ({ topic, envelope }) => {
        await this.metrics.incr('kafka.ingress.received');
        switch (topic) {
          case KafkaTopics.INCIDENTS_INGRESS:
            await this.handleIncident(envelope.payload, envelope);
            break;
          case KafkaTopics.ENVIRONMENT_INGRESS:
            await this.handleEnvironment(envelope.payload, envelope);
            break;
          case KafkaTopics.RESOURCES_INGRESS:
            await this.handleResource(envelope.payload, envelope);
            break;
          default:
            this.logger.warn(`Unhandled ingress topic ${topic}`);
        }
        await this.metrics.incr('kafka.ingress.processed');
      },
    );
  }

  private async handleIncident(
    payload: Record<string, unknown>,
    envelope: { idempotencyKey?: string; regionId?: string; eventId: string },
  ) {
    const dto = {
      regionId: String(payload.regionId || envelope.regionId || ''),
      title: String(payload.title || 'Kafka incident'),
      description:
        payload.description != null ? String(payload.description) : undefined,
      lat: Number(payload.lat),
      lng: Number(payload.lng),
      severity: Number(payload.severity ?? 3),
      affectedCount:
        payload.affectedCount != null
          ? Number(payload.affectedCount)
          : undefined,
      timeSensitivity:
        payload.timeSensitivity != null
          ? Number(payload.timeSensitivity)
          : undefined,
      resourceNeeds: (payload.resourceNeeds as Record<string, unknown>) || {
        types: ['AMBULANCE'],
      },
      environment: (payload.environment as Record<string, unknown>) || {},
      disasterType:
        payload.disasterType != null ? String(payload.disasterType) : undefined,
      idempotencyKey:
        envelope.idempotencyKey ||
        (payload.idempotencyKey != null
          ? String(payload.idempotencyKey)
          : `kafka-${envelope.eventId}`),
    };

    if (!dto.regionId || !Number.isFinite(dto.lat) || !Number.isFinite(dto.lng)) {
      throw new Error('Invalid incident ingress payload');
    }
    const created = await this.incidents.create(dto);
    this.logger.log(`Kafka→incident ${created.id} (${dto.idempotencyKey})`);
  }

  private async handleEnvironment(
    payload: Record<string, unknown>,
    envelope: { regionId?: string },
  ) {
    const regionId = String(payload.regionId || envelope.regionId || '');
    const type = String(payload.type || '') as EnvironmentEventType;
    if (!regionId || !type) throw new Error('Invalid environment ingress');
    await this.events.create({
      regionId,
      type,
      payload: (payload.payload as Record<string, unknown>) || payload,
      incidentId:
        payload.incidentId != null ? String(payload.incidentId) : undefined,
    });
    this.logger.log(`Kafka→environment ${type} region=${regionId}`);
  }

  private async handleResource(
    payload: Record<string, unknown>,
    envelope: { regionId?: string },
  ) {
    const action = String(payload.action || 'create').toLowerCase();
    if (action === 'fail' && payload.resourceId) {
      await this.resources.fail(String(payload.resourceId));
      this.logger.log(`Kafka→resource fail ${payload.resourceId}`);
      return;
    }
    if (action === 'update' && payload.resourceId) {
      await this.resources.update(String(payload.resourceId), {
        lat: payload.lat != null ? Number(payload.lat) : undefined,
        lng: payload.lng != null ? Number(payload.lng) : undefined,
        remainingCapacity:
          payload.remainingCapacity != null
            ? Number(payload.remainingCapacity)
            : undefined,
        status: payload.status as never,
        constraints: payload.constraints as Record<string, unknown> | undefined,
      });
      return;
    }

    await this.resources.create({
      regionId: String(payload.regionId || envelope.regionId || ''),
      name: String(payload.name || 'Kafka resource'),
      type: String(payload.type || 'AMBULANCE') as ResourceType,
      lat: Number(payload.lat),
      lng: Number(payload.lng),
      capacity: payload.capacity != null ? Number(payload.capacity) : 1,
      constraints: payload.constraints as Record<string, unknown> | undefined,
    });
  }
}
