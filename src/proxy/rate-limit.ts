import { Request, Response, NextFunction } from "express";
import { config } from "../config";

const ONE_MINUTE_MS = 60 * 1000;

type Timestamp = number;
/** Tracks time of last attempts from each IP address or token. */
const lastAttempts = new Map<string, Timestamp[]>();
/** Tracks time of exempted attempts from shared IPs like Agnai.chat. */
const exemptedRequests: Timestamp[] = [];

const isRecentAttempt = (now: Timestamp) => (attempt: Timestamp) =>
  attempt > now - ONE_MINUTE_MS;

/**
 * Returns duration in seconds to wait before retrying for Retry-After header.
 */
const getRetryAfter = (ip: string, type: "text" | "image") => {
  const now = Date.now();
  const attempts = lastAttempts.get(ip) || [];
  const validAttempts = attempts.filter(isRecentAttempt(now));

  const limit =
    type === "text" ? config.textModelRateLimit : config.imageModelRateLimit;

  if (validAttempts.length >= limit) {
    return (validAttempts[0] - now + ONE_MINUTE_MS) / 1000;
  } else {
    lastAttempts.set(ip, [...validAttempts, now]);
    return 0;
  }
};

const getStatus = (ip: string, type: "text" | "image") => {
  const now = Date.now();
  const attempts = lastAttempts.get(ip) || [];
  const validAttempts = attempts.filter(isRecentAttempt(now));

  const limit =
    type === "text" ? config.textModelRateLimit : config.imageModelRateLimit;

  return {
    remaining: Math.max(0, limit - validAttempts.length),
    reset: validAttempts.length > 0 ? validAttempts[0] + ONE_MINUTE_MS : now,
  };
};

/** Prunes attempts and IPs that are no longer relevant after one minute. */
const clearOldAttempts = () => {
  const now = Date.now();
  for (const [ip, attempts] of lastAttempts.entries()) {
    const validAttempts = attempts.filter(isRecentAttempt(now));
    if (validAttempts.length === 0) {
      lastAttempts.delete(ip);
    } else {
      lastAttempts.set(ip, validAttempts);
    }
  }
};
setInterval(clearOldAttempts, 10 * 1000);

/** Prunes exempted requests which are older than one minute. */
const clearOldExemptions = () => {
  const now = Date.now();
  const validExemptions = exemptedRequests.filter(isRecentAttempt(now));
  exemptedRequests.splice(0, exemptedRequests.length, ...validExemptions);
};
setInterval(clearOldExemptions, 10 * 1000);

export const getUniqueIps = () => lastAttempts.size;

/**
 * Can be used to manually remove the most recent attempt from an IP address,
 * ie. in case a prompt triggered OpenAI's content filter and therefore did not
 * result in a generation.
 */
export const refundLastAttempt = (req: Request) => {
  const key = req.user?.token || req.risuToken || req.ip;
  const attempts = lastAttempts.get(key) || [];
  attempts.pop();
};

export const ipLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const imageLimit = config.imageModelRateLimit;
  const textLimit = config.textModelRateLimit;

  if (!textLimit && !imageLimit) return next();
  if (req.user?.type === "special") return next();

  const path = req.baseUrl + req.path;
  const type =
    path.includes("openai-image") || path.includes("images/generations")
      ? "image"
      : "text";
  const limit = type === "image" ? imageLimit : textLimit;

  // If user is authenticated, key rate limiting by their token. Otherwise, key
  // rate limiting by their IP address. Mitigates key sharing.
  const rateLimitKey = req.user?.token || req.risuToken || req.ip;

  const { remaining, reset } = getStatus(rateLimitKey, type);
  res.set("X-RateLimit-Limit", limit.toString());
  res.set("X-RateLimit-Remaining", remaining.toString());
  res.set("X-RateLimit-Reset", reset.toString());

  const retryAfterTime = getRetryAfter(rateLimitKey, type);
  if (retryAfterTime > 0) {
    const waitSec = Math.ceil(retryAfterTime).toString();
    res.set("Retry-After", waitSec);
    res.status(429).json({
      error: {
        type: "proxy_rate_limited",
        message: `This model type is rate limited to ${limit} prompts per minute. Please try again in ${waitSec} seconds.`,
      },
    });
  } else {
    next();
  }
};
