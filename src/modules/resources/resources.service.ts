import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, ResourceStatus, ResourceType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_REOPT } from '../queues/queue.constants';
import { CreateResourceDto, UpdateResourceDto } from './dto/resource.dto';

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_REOPT) private readonly reoptQueue: Queue,
  ) {}

  create(dto: CreateResourceDto) {
    const capacity = dto.capacity ?? 1;
    return this.prisma.resource.create({
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
    return this.prisma.resource.update({
      where: { id },
      data: {
        ...dto,
        constraints: dto.constraints as Prisma.InputJsonValue | undefined,
        version: { increment: 1 },
      },
    });
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
    return resource;
  }
}
