import { ValueTransformer } from 'typeorm';

/**
 * TypeORM reads Postgres `numeric` columns back as strings to preserve
 * precision. Warehouse quantities fit comfortably in a JS number, so convert
 * on the way out (and pass through on the way in). Nulls stay null.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) =>
    value === null || value === undefined ? value : parseFloat(value),
};
