import { Body, Controller, Post } from '@nestjs/common';
import { ApiHeader, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { IncidentsService } from '../incidents/incidents.service';
import { EventsService } from '../events/events.service';
import { randomUUID } from 'crypto';

class ChaosDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  incidentCount?: number;

  @ApiPropertyOptional({ default: 3 })
  @IsOptional()
  @IsInt()
  failResources?: number;
}

@ApiTags('simulation')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('simulation')
export class SimulationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentsService,
    private readonly events: EventsService,
  ) {}

  @Post('chaos')
  async chaos(@Body() dto: ChaosDto) {
    const count = dto.incidentCount ?? 20;
    const failN = dto.failResources ?? 3;
    const regions = await this.prisma.region.findMany();
    if (!regions.length) {
      return { error: 'No regions seeded' };
    }

    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      const region = regions[i % regions.length];
      const severity = i % 5 === 0 ? 5 : 1 + (i % 4);
      const lat =
        region.minLat + Math.random() * (region.maxLat - region.minLat);
      const lng =
        region.minLng + Math.random() * (region.maxLng - region.minLng);
      const incident = await this.incidents.create({
        regionId: region.id,
        title: `Chaos incident #${i + 1}`,
        description: 'Simulated cascading disaster load',
        lat,
        lng,
        severity,
        affectedCount: 5 + (i % 40),
        timeSensitivity: severity,
        disasterType: ['flood', 'fire', 'medical', 'rescue'][i % 4],
        resourceNeeds: { types: ['AMBULANCE', 'RESCUE_TEAM'] },
        environment: { hazard: severity },
        idempotencyKey: `chaos-${randomUUID()}`,
      });
      created.push(incident.id);
    }

    const resources = await this.prisma.resource.findMany({
      where: { status: 'AVAILABLE' },
      take: failN,
    });
    const failed: string[] = [];
    for (const r of resources) {
      await this.events.create({
        regionId: r.regionId,
        type: 'VEHICLE_FAILED',
        payload: { resourceId: r.id },
      });
      failed.push(r.id);
    }

    if (regions[0]) {
      await this.events.create({
        regionId: regions[0].id,
        type: 'ROAD_BLOCKED',
        payload: {
          lat: (regions[0].minLat + regions[0].maxLat) / 2,
          lng: (regions[0].minLng + regions[0].maxLng) / 2,
          radiusKm: 3,
        },
      });
    }

    return {
      message: 'Chaos simulation started',
      incidentsCreated: created.length,
      resourcesFailed: failed.length,
      incidentIds: created.slice(0, 10),
    };
  }
}
