// apps/api/src/routes/common.ts
// The validate wrapper shared by every resource's route file: core zod
// schemas in, the error envelope out.
import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { errorResponse } from "../http";

export const validate = <T extends ZodType>(target: "json" | "query", schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`)
        .join("; ");
      return errorResponse(c, 400, "invalid_request_error", msg);
    }
  });
