import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class RegionsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.region.findMany({ orderBy: { code: 'asc' } });
  }

  findById(id: string) {
    return this.prisma.region.findUnique({ where: { id } });
  }

  findByCode(code: string) {
    return this.prisma.region.findUnique({ where: { code } });
  }

  async resolveRegionId(regionIdOrCode: string) {
    const byId = await this.prisma.region.findUnique({
      where: { id: regionIdOrCode },
    });
    if (byId) return byId;
    return this.prisma.region.findUnique({ where: { code: regionIdOrCode } });
  }
}
