import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiHeader,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { EnvironmentEventType } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { EventsService } from './events.service';

class CreateEventDto {
  @ApiProperty()
  @IsString()
  regionId!: string;

  @ApiProperty({ enum: EnvironmentEventType })
  @IsEnum(EnvironmentEventType)
  type!: EnvironmentEventType;

  @ApiProperty({ type: Object })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  incidentId?: string;
}

@ApiTags('events')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  create(@Body() dto: CreateEventDto) {
    return this.events.create(dto);
  }

  @Get()
  list(@Query('regionId') regionId?: string) {
    return this.events.list(regionId);
  }
}
