import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { patchVolumeSchema } from '@skvault/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { CatalogService } from './catalog.service';
import { ProjectsService } from './projects.service';

@ApiTags('catalogue')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller()
export class CatalogController {
  constructor(private readonly service: CatalogService, private readonly projectsService: ProjectsService) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('volumes')
  volumes() {
    return this.service.volumes();
  }

  @Patch('volumes/:id')
  patchVolume(@Param('id') id: string, @Body() body: unknown) {
    return this.service.patchVolume(id, patchVolumeSchema.parse(body));
  }

  @Get('projects')
  projects(
    @Query('q') q?: string,
    @Query('volumeId') volumeId?: string,
    @Query('verdict') verdict?: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
  ) {
    return this.service.projects({ q, volumeId, verdict, kind, page: page ? Math.max(1, Number(page)) : 1 });
  }

  /** Paires de bibliothèques liées : réplique, version contenue dans une autre, recoupement, complément */
  @Get('projects-relations')
  relations() {
    return this.projectsService.allRelations();
  }

  /** Recoupe les originaux introuvables avec le catalogue des autres disques (aussi lancé après chaque scan) */
  @Post('projects/recheck')
  async recheck() {
    return { checked: await this.projectsService.recheckAll() };
  }

  @Get('projects/:id')
  project(@Param('id') id: string) {
    return this.service.project(id);
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
