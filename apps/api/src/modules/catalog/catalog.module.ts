import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { ProjectsService } from './projects.service';

@Module({ imports: [AuthModule], controllers: [CatalogController], providers: [CatalogService, ProjectsService], exports: [ProjectsService] })
export class CatalogModule {}
