/**
 * Safe accessors for terminal dimensions.
 *
 * Node.js types declare `process.stdout.columns` as `number`, but at runtime
 * the value is `undefined` when stdout is not a TTY (CI, tests, piped output).
 * These helpers provide fallbacks without triggering the
 * `@typescript-eslint/no-unnecessary-condition` lint rule.
 */

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
export const termColumns = (): number => process.stdout.columns ?? 80;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
export const termRows = (): number => process.stdout.rows ?? 24;
