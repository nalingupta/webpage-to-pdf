import * as z from 'zod';

export const expansionSummarySchema = z.object({
  detected: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  nativeDetailsOpened: z.number().int().nonnegative(),
  disclosuresOpened: z.number().int().nonnegative(),
  showMoreActivated: z.number().int().nonnegative(),
  passesCompleted: z.number().int().nonnegative(),
  remainingCollapsed: z.number().int().nonnegative(),
  carousel: z.object({
    detected: z.number().int().nonnegative(),
    captured: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict(),
  diagnostics: z.array(z.object({
    label: z.string(),
    strategy: z.enum([
      "clicked normally", "details forced open", "aria-controlled panel forced visible",
      "hidden panel CSS overridden", "unresolved",
    ]),
  })),
}).strict();

export type ExpansionSummary = z.infer<typeof expansionSummarySchema>;

export function parseExpansionSummaryHeader(header: string | null): ExpansionSummary | null {
  if (!header) return null;
  try {
    return expansionSummarySchema.parse(JSON.parse(header));
  } catch {
    return null;
  }
}