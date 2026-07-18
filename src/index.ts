import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userDevices } from "./db/schema";

type Env = CloudflareBindings;

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Shared Schemas ──────────────────────────────────────────────────────────

const ErrorSchema = z.object({
  error: z.string().openapi({ example: "Missing required fields" }),
});

// ─── Health Check ─────────────────────────────────────────────────────────────

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  summary: "Health check",
  description: "Returns the service status.",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string().openapi({ example: "ok" }),
            service: z
              .string()
              .openapi({ example: "realstay-notification-worker" }),
          }),
        },
      },
    },
  },
});

app.openapi(healthRoute, (c) => {
  return c.json({ status: "ok", service: "realstay-notification-worker" }, 200);
});

// ─── Register Token ───────────────────────────────────────────────────────────

const RegisterTokenBodySchema = z.object({
  userId: z.string().openapi({ example: "user_abc123" }),
  fcmToken: z.string().openapi({ example: "fcm-token-xyz..." }),
  platform: z
    .enum(["android", "iOS"])
    .default("android")
    .openapi({ example: "android" }),
});

const registerTokenRoute = createRoute({
  method: "post",
  path: "/register-token",
  tags: ["Tokens"],
  summary: "Register a device token",
  description:
    "Called by the mobile app to register (or refresh) an FCM device token for a user.",
  request: {
    body: {
      content: { "application/json": { schema: RegisterTokenBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Token registered successfully",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean().openapi({ example: true }) }),
        },
      },
    },
    400: {
      description: "Validation error — missing required fields",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

app.openapi(registerTokenRoute, async (c) => {
  const db = drizzle(c.env.DB);
  const { userId, fcmToken, platform } = c.req.valid("json");

  await db
    .insert(userDevices)
    .values({ userId, fcmToken, platform, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: userDevices.fcmToken,
      set: { userId, platform, updatedAt: Date.now(), isActive: true },
    });

  return c.json({ success: true }, 200);
});

// ─── Send Notification ────────────────────────────────────────────────────────

const SendNotificationBodySchema = z.object({
  userId: z.string().openapi({ example: "user_abc123" }),
  title: z.string().openapi({ example: "New Message" }),
  body: z.string().openapi({ example: "You have a new message from John." }),
  data: z
    .record(z.string(), z.string())
    .optional()
    .openapi({ example: { listingId: "42", type: "chat" } }),
});

const SendNotificationResponseSchema = z.object({
  success: z.boolean().openapi({ example: true }),
  sent: z.number().openapi({ example: 2 }),
  details: z.array(z.any()),
});

const sendRoute = createRoute({
  method: "post",
  path: "/send",
  tags: ["Notifications"],
  summary: "Send a push notification",
  description:
    "Called by the RealStay backend to dispatch an FCM push notification to all active devices of a user.",
  request: {
    body: {
      content: { "application/json": { schema: SendNotificationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Notification dispatched",
      content: {
        "application/json": { schema: SendNotificationResponseSchema },
      },
    },
    400: {
      description: "Missing required fields",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "No active tokens found for the user",
      content: {
        "application/json": {
          schema: z
            .object({
              error: z.string(),
              userId: z.string().openapi({ example: "user_abc123" }),
            })
            .openapi({
              example: {
                error: "No active tokens found for user",
                userId: "user_abc123",
              },
            }),
        },
      },
    },
  },
});

app.openapi(sendRoute, async (c) => {
  const db = drizzle(c.env.DB);
  const { userId, title, body, data } = c.req.valid("json");

  const tokens = await db
    .select()
    .from(userDevices)
    .where(and(eq(userDevices.userId, userId), eq(userDevices.isActive, true)));

  if (!tokens.length) {
    return c.json({ error: "No active tokens found for user", userId }, 404);
  }

  const results = await Promise.all(
    tokens.map(async (t) => {
      const response = await fetch(`${c.env.BACKEND_URL}/notifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t.fcmToken, title, body, data }),
      });

      const result: {
        data: { message: string; path: string };
        success: boolean;
      } = await response.json();

      if (
        !result.success &&
        result.data?.message?.includes("invalid device token")
      ) {
        await db
          .update(userDevices)
          .set({ isActive: false })
          .where(eq(userDevices.fcmToken, t.fcmToken));
      }
      return result;
    }),
  );

  const anySuccess = results.some((r) => r.success);
  return c.json(
    { success: anySuccess, sent: tokens.length, details: results },
    200,
  );
});

// ─── Delete Token ─────────────────────────────────────────────────────────────

const deleteTokenRoute = createRoute({
  method: "delete",
  path: "/tokens/{token}",
  tags: ["Tokens"],
  summary: "Remove a device token",
  description: "Permanently deletes a specific FCM token from the database.",
  request: {
    params: z.object({
      token: z.string().openapi({ example: "fcm-token-xyz..." }),
    }),
  },
  responses: {
    200: {
      description: "Token removed",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean().openapi({ example: true }) }),
        },
      },
    },
  },
});

app.openapi(deleteTokenRoute, async (c) => {
  const db = drizzle(c.env.DB);
  const { token } = c.req.valid("param");
  await db.delete(userDevices).where(eq(userDevices.fcmToken, token));
  return c.json({ success: true }, 200);
});

// ─── OpenAPI Spec + Swagger UI ────────────────────────────────────────────────

app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "RealStay In-App Notification Service",
    version: "1.0.0",
    description:
      "Cloudflare Worker API for registering FCM device tokens and dispatching push notifications.",
  },
  servers: [
    {
      url: "https://realstay-inappnotificationservice.media-edgetech.workers.dev",
      description: "Production server",
    },
  ],
});

app.get("/ui", swaggerUI({ url: "/doc" }));

export default app;
