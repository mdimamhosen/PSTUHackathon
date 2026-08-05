import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiHeader,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';

class OverrideDto {
  @ApiProperty()
  @IsString()
  incidentId!: string;

  @ApiProperty()
  @IsString()
  resourceId!: string;

  @ApiProperty()
  @IsString()
  actor!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('dispatches')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('dispatches')
export class DispatchController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.dispatchAssignment.findMany({
      include: { incident: true, resource: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post(':id/acknowledge')
  async acknowledge(@Param('id') id: string) {
    return this.prisma.dispatchAssignment.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED' },
    });
  }

  @Post('override')
  async override(@Body() dto: OverrideDto) {
    const resource = await this.prisma.resource.findUniqueOrThrow({
      where: { id: dto.resourceId },
    });
    return this.prisma.dispatchAssignment.create({
      data: {
        incidentId: dto.incidentId,
        resourceId: dto.resourceId,
        role: resource.type,
        etaMinutes: 0,
        score: 0,
        explanation: `Manual override by ${dto.actor}: ${dto.reason || 'n/a'}`,
        status: 'ASSIGNED',
        scoreBreakdown: { override: 1, actor: dto.actor },
      },
    });
  }
}
