import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { MAX_UPLOAD_BYTES } from './common/uploaded-file.util';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Enables multipart/form-data file uploads (read via readSingleUploadedFile).
  // One file per request, capped at MAX_UPLOAD_BYTES.
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // Comma-separated allowlist, e.g. "https://app.example.com,http://localhost:3000".
  // Defaults to the local FE dev origin.
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  // Bind IPv6 dual-stack (`::`): required for Railway private networking (IPv6-only),
  // and still serves the public edge proxy over IPv4. Override with HOST if needed.
  await app.listen(process.env.PORT ?? 3003, process.env.HOST ?? '::');
}

bootstrap();
