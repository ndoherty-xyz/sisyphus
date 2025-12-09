import pino from "pino";

export function createLogger(serviceName: string) {
  return pino({
    level: "info",
    base: {
      serviceName,
    },
    transport: process.stdout.isTTY
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        }
      : undefined,
  });
}

export const sharedLogger = createLogger("shared");
