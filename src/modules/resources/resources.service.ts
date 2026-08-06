import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, ResourceStatus, ResourceType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_REOPT } from '../queues/queue.constants';
import { CreateResourceDto, UpdateResourceDto } from './dto/resource.dto';
import { KafkaService } from '../kafka/kafka.service';
import { KafkaTopics } from '../kafka/kafka.topics';

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    @InjectQueue(QUEUE_REOPT) private readonly reoptQueue: Queue,
  ) {}

  async create(dto: CreateResourceDto) {
    const capacity = dto.capacity ?? 1;
    const resource = await this.prisma.resource.create({
      data: {
        regionId: dto.regionId,
        name: dto.name,
        type: dto.type,
        lat: dto.lat,
        lng: dto.lng,
        capacity,
        remainingCapacity: capacity,
        constraints: (dto.constraints || {}) as Prisma.InputJsonValue,
      },
    });
    void this.kafka.publish(
      KafkaTopics.RESOURCES_UPDATED,
      { action: 'create', resource },
      {
        key: resource.id,
        regionId: resource.regionId,
        eventType: 'resource.created',
      },
    );
    return resource;
  }

  findAvailable(type?: ResourceType, regionId?: string) {
    return this.prisma.resource.findMany({
      where: {
        status: ResourceStatus.AVAILABLE,
        remainingCapacity: { gt: 0 },
        ...(type ? { type } : {}),
        ...(regionId ? { regionId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async update(id: string, dto: UpdateResourceDto) {
    const existing = await this.prisma.resource.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Resource not found');
    const resource = await this.prisma.resource.update({
      where: { id },
      data: {
        ...dto,
        constraints: dto.constraints as Prisma.InputJsonValue | undefined,
        version: { increment: 1 },
      },
    });
    void this.kafka.publish(
      KafkaTopics.RESOURCES_UPDATED,
      { action: 'update', resource },
      {
        key: resource.id,
        regionId: resource.regionId,
        eventType: 'resource.updated',
      },
    );
    return resource;
  }

  async fail(id: string) {
    const resource = await this.prisma.resource.update({
      where: { id },
      data: { status: ResourceStatus.FAILED, version: { increment: 1 } },
    });
    await this.prisma.dispatchAssignment.updateMany({
      where: {
        resourceId: id,
        status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] },
      },
      data: { status: 'RELEASED' },
    });
    await this.reoptQueue.add(
      'reopt',
      { regionId: resource.regionId, reason: `resource_failed:${id}` },
      {
        jobId: `reopt-${resource.regionId}`,
        delay: 500,
        removeOnComplete: 1000,
      },
    );
    void this.kafka.publish(
      KafkaTopics.RESOURCES_FAILED,
      { resourceId: id, regionId: resource.regionId, status: 'FAILED' },
      {
        key: id,
        regionId: resource.regionId,
        eventType: 'resource.failed',
      },
    );
    void this.kafka.publish(
      KafkaTopics.REGION_REOPT_TRIGGERED,
      { regionId: resource.regionId, reason: `resource_failed:${id}` },
      { key: resource.regionId, regionId: resource.regionId },
    );
    return resource;
  }
}
