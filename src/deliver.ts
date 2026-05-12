import {
  deliverOutboundPayloads,
  type DeliverOutboundPayloadsParams,
} from "openclaw/plugin-sdk/outbound-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { CodexInfoConfig } from "./config.js";
import { getActiveDeliveries } from "./config.js";
import { renderNotificationText } from "./render.js";
import type { CodexInfoEvent } from "./types.js";

export interface DeliverParams {
  event: CodexInfoEvent;
  config: CodexInfoConfig;
  cfg: OpenClawConfig;
  logger?: { error?: (message: string) => void };
  renderedText?: string;
}

export interface DeliveryResult {
  success: number;
  failed: number;
  errors: string[];
}

export async function deliverNotification(params: DeliverParams): Promise<DeliveryResult> {
  const { event, config, cfg, logger, renderedText } = params;
  const text = renderedText ?? renderNotificationText(event, config);
  const deliveries = getActiveDeliveries(config);

  const result: DeliveryResult = { success: 0, failed: 0, errors: [] };

  for (const delivery of deliveries) {
    try {
      await deliverOutboundPayloads({
        cfg,
        channel: delivery.channel as DeliverOutboundPayloadsParams["channel"],
        to: delivery.to,
        payloads: [{ text }],
      });
      result.success++;
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${delivery.channel}: ${msg}`);
      logger?.error?.(`[codexinfo] delivery failed: ${delivery.channel}: ${msg}`);
    }
  }

  return result;
}

export async function deliverText(params: {
  text: string;
  config: CodexInfoConfig;
  cfg: OpenClawConfig;
  logger?: { error?: (message: string) => void };
}): Promise<DeliveryResult> {
  const { text, config, cfg, logger } = params;
  const deliveries = getActiveDeliveries(config);
  const result: DeliveryResult = { success: 0, failed: 0, errors: [] };

  for (const delivery of deliveries) {
    try {
      await deliverOutboundPayloads({
        cfg,
        channel: delivery.channel as DeliverOutboundPayloadsParams["channel"],
        to: delivery.to,
        payloads: [{ text }],
      });
      result.success++;
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${delivery.channel}: ${msg}`);
      logger?.error?.(`[codexinfo] deliver-text failed: ${delivery.channel}: ${msg}`);
    }
  }

  return result;
}
