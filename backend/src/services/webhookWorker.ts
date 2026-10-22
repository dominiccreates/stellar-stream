import axios from "axios";
import { getDb } from "./db";
import {
  recordDeliveryFailure,
  recordDeliverySuccess,
  type WebhookDeliveryAttemptResult,
} from "./webhook";
import { getWebhookHeaders } from "./webhookSignature";
import { validateWebhookUrl } from "./webhookUrl";
import { logger } from "../logger";

let isProcessing = false;
let pollingInterval: NodeJS.Timeout | null = null;

export const processWebhookQueue = async (): Promise<WebhookDeliveryAttemptResult[]> => {
  if (isProcessing) return [];
  isProcessing = true;

  const committedResults: WebhookDeliveryAttemptResult[] = [];

  try {
    const url = process.env.WEBHOOK_DESTINATION_URL;
    if (!url) {
      return [];
    }

    const urlValidation = validateWebhookUrl(url);
    if (!urlValidation.valid) {
      logger.error({ reason: urlValidation.reason }, "webhook delivery skipped because destination URL is invalid");
      return [];
    }

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    // Fetch pending deliveries that are due (aligning NULL or <= now with monitoring queries)
    const pendingDeliveries = db
      .prepare(
        `SELECT * FROM webhook_deliveries 
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?) 
         ORDER BY next_retry_at ASC, id ASC LIMIT 10`
      )
      .all(now);

    for (const delivery of pendingDeliveries) {
      const { id, event, payload, attempt } = delivery;
      const parsedPayload = JSON.parse(payload);

      let success = false;
      let errorMsg: string | null = null;

      try {
        const timestamp = new Date().toISOString();
        const body = {
          event,
          payload: parsedPayload,
          timestamp,
        };
        const bodyString = JSON.stringify(body);
        const headers = getWebhookHeaders(
          bodyString,
          process.env.WEBHOOK_SIGNING_SECRET,
        );

        const response = await axios.post(url, bodyString, { headers });
        if (response && typeof response.status === "number" && response.status >= 400) {
          const statusSuffix = response.statusText ? ` ${response.statusText}` : "";
          throw new Error(`HTTP ${response.status}${statusSuffix}`);
        }
        success = true;
      } catch (error: any) {
        errorMsg =
          error?.message ||
          (error?.response?.status ? `HTTP ${error.response.status}` : "Unknown error");
        logger.error({ err: error, deliveryId: id, attempt: attempt + 1 }, "webhook delivery attempt failed");
      }

      const updateNow = Math.floor(Date.now() / 1000);

      try {
        if (success) {
          const committed = recordDeliverySuccess(id, updateNow);
          if (committed) {
            committedResults.push(committed);
            logger.info({ deliveryId: id, event, attempt: committed.attempt }, "webhook delivery succeeded");
          }
        } else {
          const committed = recordDeliveryFailure(
            id,
            url,
            errorMsg ?? "Unknown error",
            updateNow,
          );
          if (committed) {
            committedResults.push(committed);
            if (committed.status === "dead_lettered") {
              logger.error(
                { deliveryId: id, event, maxAttempts: committed.max_attempts },
                "webhook delivery moved to dead-letter storage",
              );
            } else {
              logger.info(
                {
                  deliveryId: id,
                  event,
                  attempt: committed.attempt,
                  delaySeconds: committed.delay_seconds,
                  nextRetryAt:
                    committed.next_retry_at !== null
                      ? new Date(committed.next_retry_at * 1000).toISOString()
                      : null,
                },
                "webhook delivery scheduled for retry",
              );
            }
          }
        }
      } catch (dbErr: any) {
        logger.error(
          { err: dbErr, deliveryId: id, event },
          "failed to commit webhook delivery state transition",
        );
      }
    }
  } catch (err: any) {
    logger.error({ err }, "error processing webhook queue");
  } finally {
    isProcessing = false;
  }

  return committedResults;
};

export const startWebhookWorker = (intervalMs: number = 5000) => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  // Immediately process
  processWebhookQueue();
  // Set interval
  pollingInterval = setInterval(processWebhookQueue, intervalMs);
  logger.info({ intervalMs }, "webhook worker started");
};

export const stopWebhookWorker = () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    logger.info("webhook worker stopped");
  }
};
