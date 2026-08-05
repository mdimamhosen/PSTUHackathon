import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { MetricsService } from './metrics.service';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get()
  async getMetrics() {
    const [snap, resources, incidents, assignments] = await Promise.all([
      this.metrics.snapshot(),
      this.prisma.resource.groupBy({ by: ['status'], _count: true }),
      this.prisma.incident.groupBy({ by: ['status'], _count: true }),
      this.prisma.dispatchAssignment.count({
        where: { status: { in: ['ASSIGNED', 'ACKNOWLEDGED', 'EN_ROUTE'] } },
      }),
    ]);
    const totalRes = resources.reduce((a, r) => a + r._count, 0);
    const available =
      resources.find((r) => r.status === 'AVAILABLE')?._count || 0;
    const utilization =
      totalRes === 0
        ? 0
        : Math.round(((totalRes - available) / totalRes) * 100);
    return {
      ...snap,
      resourceUtilizationPct: utilization,
      resourcesByStatus: Object.fromEntries(
        resources.map((r) => [r.status, r._count]),
      ),
      incidentsByStatus: Object.fromEntries(
        incidents.map((r) => [r.status, r._count]),
      ),
      activeAssignments: assignments,
    };
  }
}
