import type { z } from 'zod';
import { formatValidationErrors } from './validators.js';

/**
 * Validation result: either a valid parsed value or error details for re-prompt.
 */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: string; raw: unknown };

/**
 * Validate raw output against a zod schema.
 * Returns parsed data on success, or formatted errors on failure.
 */
export function validateOutput<T>(raw: unknown, schema: z.ZodType<T>): ValidationResult<T> {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    errors: formatValidationErrors(result.error),
    raw
  };
}

/**
 * Retry-once wrapper.
 *
 * 1. Calls `produce()` to get raw output.
 * 2. Validates with schema.
 * 3. On failure: calls `produce(retryPrompt)` with validation errors embedded.
 * 4. Validates again.
 * 5. Second failure: returns { ok: false, ... } — caller emits ERROR + continues degraded.
 *
 * `produce` is an async function that takes an optional retry prompt and returns raw JSON.
 * In stub mode it returns hardcoded JSON. When Dify is wired in, it calls the workflow API.
 */
export async function validateWithRetry<T>(
  schema: z.ZodType<T>,
  schemaName: string,
  produce: (retryPrompt?: string) => Promise<unknown>
): Promise<ValidationResult<T>> {
  // First attempt
  const raw1 = await produce();
  const result1 = validateOutput(raw1, schema);
  if (result1.ok) return result1;

  // Build retry prompt with errors + schema description
  const retryPrompt = [
    `Your previous ${schemaName} output failed validation. Fix these errors and return ONLY valid JSON:`,
    '',
    result1.errors,
    '',
    `Schema: ${schemaName}`,
    `Raw output that failed: ${JSON.stringify(result1.raw).slice(0, 500)}`
  ].join('\n');

  // Second attempt
  const raw2 = await produce(retryPrompt);
  const result2 = validateOutput(raw2, schema);
  if (result2.ok) return result2;

  // Both failed — caller handles degraded mode
  return result2;
}
