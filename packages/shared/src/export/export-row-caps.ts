import { IntValue } from '../nest/env-decorators';

/**
 * The row caps of exports (ticket #16), defined once for the api and the exporter. Kept apart from `export-jobs.ts`
 * (ClickHouse) so that a config class can import it alone.
 */

/** The formats an export can be made in: the list's CSV, or a PDF document of it (ticket #17). */
export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Whether `format` is one an export can be made in. */
export function isExportFormat(format: unknown): format is ExportFormat {
  return (EXPORT_FORMATS as readonly unknown[]).includes(format);
}

/**
 * The most rows an export of each format may hold (ticket #16): beyond, the api refuses it when it knows the count up
 * front, and the exporter fails it when the list turns out longer.
 */
export type ExportRowCaps = Record<ExportFormat, number>;

/** The caps by default: 1,000,000 rows of CSV, 10,000 of PDF. `GH_EXPORT_MAX_ROWS_CSV` and `_PDF` change them. */
export const EXPORT_MAX_ROWS: ExportRowCaps = { csv: 1_000_000, pdf: 10_000 };

/**
 * The validator of `GH_EXPORT_MAX_ROWS_CSV` and `_PDF` in the config of the api and of the exporter: a positive
 * integer; unset takes the initializer of the property, which is `EXPORT_MAX_ROWS` of its format.
 */
export function ExportRowCapValue(): PropertyDecorator {
  return IntValue({ min: 1 });
}
