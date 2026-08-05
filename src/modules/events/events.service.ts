import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EnvironmentEventType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RegionsService } from '../regions/regions.service';
import { QUEUE_REOPT } from '../queues/queue.constants';
import { MapsService } from '../maps/maps.service';
import { RoutingService } from '../optimization/routing.service';

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regions: RegionsService,
    private readonly maps: MapsService,
    private readonly routing: RoutingService,
    @InjectQueue(QUEUE_REOPT) private readonly reoptQueue: Queue,
  ) {}

  async create(input: {
    regionId: string;
    type: EnvironmentEventType;
    payload: Record<string, unknown>;
    incidentId?: string;
  }) {
    const region = await this.regions.resolveRegionId(input.regionId);
    if (!region) throw new NotFoundException('Region not found');

    if (input.type === 'HOSPITAL_FULL' && input.payload.resourceId) {
      await this.prisma.resource.update({
        where: { id: String(input.payload.resourceId) },
        data: {
          remainingCapacity: 0,
          status: 'BUSY',
          version: { increment: 1 },
        },
      });
    }
    if (input.type === 'VEHICLE_FAILED' && input.payload.resourceId) {
      await this.prisma.resource.update({
        where: { id: String(input.payload.resourceId) },
        data: { status: 'FAILED', version: { increment: 1 } },
      });
      await this.prisma.dispatchAssignment.updateMany({
        where: {
          resourceId: String(input.payload.resourceId),
          status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] },
        },
        data: { status: 'RELEASED' },
      });
    }

    if (input.type === 'CAPACITY_CHANGE' && input.payload.resourceId) {
      const remaining = Number(input.payload.remainingCapacity ?? 0);
      await this.prisma.resource.update({
        where: { id: String(input.payload.resourceId) },
        data: {
          remainingCapacity: Math.max(0, remaining),
          status: remaining > 0 ? 'AVAILABLE' : 'BUSY',
          version: { increment: 1 },
        },
      });
    }

    // COMMS_DELAY: record + soft reopt (do not mark resources failed without heartbeat evidence)
    const immediate =
      input.type === 'VEHICLE_FAILED' ||
      input.type === 'ROAD_BLOCKED' ||
      input.type === 'HOSPITAL_FULL';

    const event = await this.prisma.environmentEvent.create({
      data: {
        regionId: region.id,
        type: input.type,
        payload: input.payload as Prisma.InputJsonValue,
        incidentId: input.incidentId,
        active: true,
      },
    });

    await this.maps.invalidateRegionApprox();
    this.routing.invalidateRegion(region.id);
    await this.reoptQueue.add(
      'reopt',
      { regionId: region.id, reason: input.type },
      {
        jobId: `reopt-${region.id}`,
        delay: immediate ? 0 : input.type === 'COMMS_DELAY' ? 3000 : 2000,
        removeOnComplete: 1000,
      },
    );
    return event;
  }

  list(regionId?: string) {
    return this.prisma.environmentEvent.findMany({
      where: {
        active: true,
        ...(regionId ? { regionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
