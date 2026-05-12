import { z } from "zod";

const DeliveryEntrySchema = z.object({
  channel: z.string().min(1),
  to: z.string().min(1),
});

const RoutingSchema = z.object({
  mode: z.enum(["broadcast", "channels"]),
  targetChannels: z.array(z.string()).default([]),
});

const JournalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().int().positive().default(7),
});

const DiagnosticsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  logDir: z.string().optional(),
  retentionDays: z.number().int().positive().default(7),
  rawCapture: z.boolean().default(false),
});

const DisplayConfigSchema = z.object({
  weeklyResetFormat: z.enum(["date", "weekday-time"]).default("date"),
});

export const CodexInfoConfigSchema = z.object({
  token: z.string().min(16),
  deliveries: z.array(DeliveryEntrySchema).min(1),
  routing: RoutingSchema.default({ mode: "broadcast", targetChannels: [] }),
  journal: JournalConfigSchema.default({ enabled: true, retentionDays: 7 }),
  diagnostics: DiagnosticsConfigSchema.default({
    enabled: false,
    retentionDays: 7,
    rawCapture: false,
  }),
  display: DisplayConfigSchema.default({ weeklyResetFormat: "date" }),
});

export type CodexInfoConfig = z.infer<typeof CodexInfoConfigSchema>;
export type JournalConfig = z.infer<typeof JournalConfigSchema>;
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;
export type RoutingConfig = z.infer<typeof RoutingSchema>;

export function parseConfig(raw: unknown): CodexInfoConfig | null {
  const result = CodexInfoConfigSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

export function getActiveDeliveries(
  config: CodexInfoConfig,
): Array<{ channel: string; to: string }> {
  const { routing, deliveries } = config;
  if (routing.mode === "broadcast") return deliveries;
  return deliveries.filter((d) => routing.targetChannels.includes(d.channel));
}
