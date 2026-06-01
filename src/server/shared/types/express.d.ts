import type { Logger } from "pino";

declare module "express-serve-static-core" {
  interface Request {
    id?: string;
    validatedBody?: unknown;
    log?: Logger;
  }
}

export {};
