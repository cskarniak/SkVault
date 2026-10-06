import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from '../auth/jwt.guard';
import { CatalogService } from './catalog.service';

@ApiTags('catalogue')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller()
export class CatalogController {
  constructor(private readonly service: CatalogService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('volumes')
  volumes() {
    return this.service.volumes();
  }

  @Delete('volumes/:id')
  removeVolume(@Param('id') id: string) {
    return this.service.removeVolume(id);
  }

  @Get('files')
  search(
    @Query('q') q?: string,
    @Query('ext') ext?: string,
    @Query('volumeId') volumeId?: string,
    @Query('minSize') minSize?: string,
    @Query('page') page?: string,
  ) {
    return this.service.search({
      q, ext, volumeId,
      minSize: minSize ? Number(minSize) : undefined,
      page: page ? Math.max(1, Number(page)) : 1,
    });
  }

  @Get('duplicates')
  duplicates(@Query('minSize') minSize?: string, @Query('page') page?: string) {
    return this.service.duplicates(minSize ? Number(minSize) : 0, page ? Math.max(1, Number(page)) : 1);
  }
}
