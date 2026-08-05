import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { RegionsService } from './regions.service';

@ApiTags('regions')
@Controller('regions')
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  @Public()
  @Get()
  list() {
    return this.regions.findAll();
  }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) {
    return this.regions.findById(id);
  }
}
