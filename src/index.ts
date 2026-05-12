import { definePluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { parseConfig } from "./config.js";
import { deliverNotification } from "./deliver.js";
import { createDiagnosticsLogger } from "./diagnostics.js";
import { createHookHandler, createDeliverTextHandler } from "./http.js";
import { deliverText } from "./deliver.js";
import { writeJournalEntry } from "./journal.js";
import type { CodexInfoEvent } from "./types.js";

export default definePluginEntry({
  id: "codexinfo",
  name: "CodexInfo",
  description:
    "Codex CLI completion, approval-wait, and rate-limit notifications for OpenClaw channels.",
  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);

    if (config) {
      if (config.diagnostics.rawCapture) {
        process.stderr.write(
          "[codexinfo] WARNING: diagnostics.rawCapture enabled — payload keys will be written to JSONL logs\n",
        );
      }

      const diag = createDiagnosticsLogger(config.diagnostics);
      diag.rotate();

      const onEvent = async (event: CodexInfoEvent): Promise<void> => {
        if (config.journal.enabled) {
          writeJournalEntry(event);
        }

        const result = await deliverNotification({
          event,
          config,
          cfg: api.config,
          logger: api.logger,
        });

        diag.write({
          schema: "codexinfo-v1",
          eventType: event.eventType,
          eventId: event.eventId,
          receivedAt: event.receivedAt,
          deliverySuccess: result.success,
          deliveryFailed: result.failed,
        });
      };

      const handler = createHookHandler({ config, onEvent, logger: api.logger });

      api.registerHttpRoute({
        path: "/plugins/codexinfo/hook",
        auth: "plugin",
        match: "exact",
        replaceExisting: true,
        handler,
      });

      api.logger.info?.("[codexinfo] registered POST /plugins/codexinfo/hook");

      const deliverTextHandler = createDeliverTextHandler({
        config,
        onText: async (text: string) => {
          await deliverText({ text, config, cfg: api.config, logger: api.logger });
        },
        logger: api.logger,
      });

      api.registerHttpRoute({
        path: "/plugins/codexinfo/deliver-text",
        auth: "plugin",
        match: "exact",
        replaceExisting: true,
        handler: deliverTextHandler,
      });

      api.logger.info?.("[codexinfo] registered POST /plugins/codexinfo/deliver-text");
    } else {
      api.logger.error?.(
        "[codexinfo] Not configured — run `openclaw codexinfo setup` to configure.",
      );
    }

    // Always register CLI so setup/doctor/status/uninstall work before first config
    api.registerCli(
      async ({ program }) => {
        const { registerCodexinfoCli } = await import("./cli/index.js");
        registerCodexinfoCli({ program, config, cfg: api.config });
      },
      {
        descriptors: [
          {
            name: "codexinfo",
            description: "Manage CodexInfo — Codex CLI notifications",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
