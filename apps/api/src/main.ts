import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

// Les tailles de fichiers (BigInt Postgres) restent < 2^53 : sérialisées en nombre JSON.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '20mb' });
  app.enableCors({ origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:3010' });

  const config = new DocumentBuilder()
    .setTitle('SkVault API')
    .setDescription('Catalogue des disques : inventaire, recherche et doublons')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = process.env['API_PORT'] ?? 3011;
  const host = process.env['API_HOST'];
  if (host) await app.listen(port, host);
  else await app.listen(port);
  console.log(`API démarrée sur http://${host ?? 'localhost'}:${port}`);
}

bootstrap();
