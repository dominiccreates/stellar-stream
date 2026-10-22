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

function sanitizeWebhookError(error: any): Record<string, unknown> {
  if (!error) {
    return { message: "Unknown error" };
  }

  const summary: Record<string, unknown> = {
    name: error.name,
    message: error.message || "Unknown error",
    code: error.code,
  };

  const statusCode = error.response?.status ?? error.status;
  if (typeof statusCode === "number") {
    summary.statusCode = statusCode;
  }

  if (typeof error.cause === "string") {
    summary.cause = error.cause;
  }

  return summary;
}

export const processWebhookQueue = async () => {
  if (isProcessing) return;
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
      const startTime = Date.now();

      let success = false;
      let errorMsg: string | null = null;

      try {
        const body = {
          event,
          payload: parsedPayload,
          timestamp: new Date(Number(delivery.created_at) * 1000).toISOString(),
        };
        const bodyString = JSON.stringify(body);
        const headers = getWebhookHeaders(
          bodyString,
          process.env.WEBHOOK_SIGNING_SECRET,
          String(id),
        );

        const response = await axios.post(url, bodyString, {
          headers,
          validateStatus: () => true,
        });
        const latencyMs = Math.max(0, Date.now() - startTime);

        if (response.status >= 200 && response.status < 300) {
          success = true;
          logger.info(
            {
              event,
              deliveryId: id,
              streamId: delivery.stream_id,
              attempt: attempt + 1,
              statusCode: response.status,
              outcome: "success",
              outcomeCode: 0,
              latencyMs,
              isNormalEmpty: false,
            },
            "webhook delivery succeeded",
          );
        } else {
          errorMsg = `HTTP ${response.status}`;
          logger.warn(
            {
              event,
              deliveryId: id,
              streamId: delivery.stream_id,
              statusCode: response.status,
              attempt: attempt + 1,
              latencyMs,
              outcome: response.status >= 500 && response.status < 600 ? "transient_delay" : "blocked",
              outcomeCode: response.status >= 500 && response.status < 600 ? 1 : 2,
              isNormalEmpty: false,
              detail: response.status >= 500 && response.status < 600
                ? "Temporary 5xx response from the webhook endpoint; retry scheduled."
                : `Webhook endpoint returned HTTP ${response.status}; retry scheduled if attempts remain.`,
            },
            "webhook delivery attempt failed",
          );
        }
      } catch (error: any) {
        const latencyMs = Math.max(0, Date.now() - startTime);
        errorMsg = error.message || "Unknown error";
        logger.warn(
          {
            event,
            deliveryId: id,
            streamId: delivery.stream_id,
            attempt: attempt + 1,
            latencyMs,
            outcome: "transient_delay",
            outcomeCode: 1,
            isNormalEmpty: false,
            detail: "Webhook endpoint timed out or was unreachable; retry scheduled.",
            error: sanitizeWebhookError(error),
          },
          "webhook delivery attempt failed",
        );
      }

      const updateNow = Math.floor(Date.now() / 1000);

      if (success) {
        // Mark as success
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'success', last_attempt_at = ?, next_retry_at = NULL WHERE id = ?`
        ).run(updateNow, id);
        logger.info({ deliveryId: id, event }, "webhook delivery succeeded");
      } else {
        // Handle failure and retries
        const newAttempt = attempt + 1;
        if (newAttempt >= max_attempts) {
          // Move to dead-letter storage
          db.prepare(
            `INSERT INTO webhook_dead_letters (stream_id, event, url, payload, last_error, failed_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(delivery.stream_id, event, url, payload, errorMsg, updateNow);

          db.prepare(
            `DELETE FROM webhook_deliveries WHERE id = ?`
          ).run(id);
          logger.error({ deliveryId: id, event, maxAttempts: max_attempts }, "webhook delivery moved to dead-letter storage");
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
    logger.error({ error: sanitizeWebhookError(err) }, "error processing webhook queue");
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
