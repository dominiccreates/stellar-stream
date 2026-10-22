import { Request, Response, NextFunction } from "express";
import { sendApiError } from "../apiErrors";

/**
 * Admin API key authentication middleware.
 *
 * Boundary contract (see #1109 and README "Admin API Key Boundaries"):
 *
 *   - Header `X-Admin-Key` missing           -> 401 ADMIN_KEY_MISSING
 *   - Header empty / whitespace / not string -> 401 ADMIN_KEY_MALFORMED
 *   - `ADMIN_API_KEY` env unset              -> 401 ADMIN_KEY_NOT_CONFIGURED
 *   - Header present, does not match env     -> 401 ADMIN_KEY_INVALID
 *   - Header present, matches env            -> next()
 *
 * The env var is read on every request, not cached at startup. Rotating the
 * key therefore requires a process restart; any request already inside the
 * handler before the restart completes under the key value that was in
 * `process.env` when it entered. No key is retained past restart.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.ADMIN_API_KEY;

  if (!configured || configured.length === 0) {
    sendApiError(req, res, 401, "Admin API key is not configured on this server.", {
      code: "ADMIN_KEY_NOT_CONFIGURED",
    });
    return;
  }

  const rawHeader = req.header("X-Admin-Key");

  // Express joins duplicate headers into an array; a repeated X-Admin-Key is
  // ambiguous and must be rejected rather than coerced.
  if (Array.isArray(rawHeader)) {
    sendApiError(req, res, 401, "Ambiguous X-Admin-Key header (multiple values).", {
      code: "ADMIN_KEY_MALFORMED",
    });
    return;
  }

  if (rawHeader === undefined) {
    sendApiError(req, res, 401, "Missing X-Admin-Key header.", {
      code: "ADMIN_KEY_MISSING",
    });
    return;
  }

  const key = rawHeader.trim();
  if (key.length === 0) {
    sendApiError(req, res, 401, "Empty X-Admin-Key header.", {
      code: "ADMIN_KEY_MALFORMED",
    });
    return;
  }

  if (key !== configured) {
    sendApiError(req, res, 401, "Invalid Admin API key.", {
      code: "ADMIN_KEY_INVALID",
    });
    return;
  }

  next();
}
