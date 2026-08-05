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
import { ResourceType } from '@prisma/client';
import { ResourcesService } from './resources.service';
import { CreateResourceDto, UpdateResourceDto } from './dto/resource.dto';

@ApiTags('resources')
@ApiHeader({ name: 'x-api-key', required: false })
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Post()
  create(@Body() dto: CreateResourceDto) {
    return this.resources.create(dto);
  }

  @Get('available')
  available(
    @Query('type') type?: ResourceType,
    @Query('regionId') regionId?: string,
  ) {
    return this.resources.findAvailable(type, regionId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateResourceDto) {
    return this.resources.update(id, dto);
  }

  @Post(':id/fail')
  fail(@Param('id') id: string) {
    return this.resources.fail(id);
  }
}
