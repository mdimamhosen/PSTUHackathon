import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { IncidentStatus } from '@prisma/client';
import { IncidentsService } from './incidents.service';
import { CreateIncidentDto, UpdateIncidentDto } from './dto/incident.dto';

@ApiTags('incidents')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  create(@Body() dto: CreateIncidentDto) {
    return this.incidents.create(dto);
  }

  @Get()
  list(@Query('status') status?: IncidentStatus) {
    return this.incidents.findAll(status);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.incidents.findOne(id);
  }

  @Get(':id/agent-run')
  agentRun(@Param('id') id: string) {
    return this.incidents.agentRun(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateIncidentDto) {
    return this.incidents.update(id, dto);
  }
}
