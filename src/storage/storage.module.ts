import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Global so any feature module can inject `StorageService` without re-importing.
 * The service is feature-agnostic (see its docblock) and shared across the app —
 * credit bills today, other uploads (e.g. shipment images) later.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
