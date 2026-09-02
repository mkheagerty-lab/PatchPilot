import pino from "pino";

/**
 * Standalone pino logger for the worker process. apps/api gets structured
 * logging + per-request correlation for free from Fastify's built-in pino
 * instance; the worker has no HTTP request to derive one from, so it needs
 * its own. LOG_LEVEL matches apps/api's config field of the same name so the
 * two processes' logs behave consistently.
 */
export const logger = pino({ level: process.env.LOG_LEVEL || "info" });
