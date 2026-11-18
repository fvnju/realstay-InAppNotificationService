import { Hono } from "hono";

/**
 * The notification Worker, now a thin forwarder. The RealStay backend
 * (`/v1/notifications`) stores the device tokens and sends every push.
 * Only old app versions still call this Worker. Turn it off when few of
 * them are left: `/register-token` takes any user ID without a login.
 */
type Env = CloudflareBindings & { WORKER_KEY: string };

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({ status: "ok", service: "realstay-notification-worker" }, 200),
);

// Old apps register their FCM token here after sign-in.
app.post("/register-token", async (c) => {
  const body = await c.req
    .json<{ userId?: unknown; fcmToken?: unknown; platform?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.userId !== "string" || typeof body.fcmToken !== "string") {
    return c.json({ error: "Missing required fields" }, 400);
  }
  const platform =
    String(body.platform ?? "android").toLowerCase() === "ios" ? "ios" : "android";

  const response = await fetch(
    `${c.env.BACKEND_URL}/v1/notifications/worker/tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-worker-key": c.env.WORKER_KEY,
      },
      body: JSON.stringify({
        userId: body.userId,
        fcmToken: body.fcmToken,
        platform,
      }),
    },
  );
  return c.json({ success: response.ok }, response.ok ? 200 : 502);
});

// Old apps delete their token here at sign-out.
app.delete("/tokens/:token", async (c) => {
  const token = c.req.param("token");
  const response = await fetch(
    `${c.env.BACKEND_URL}/v1/notifications/tokens/${encodeURIComponent(token)}`,
    { method: "DELETE" },
  );
  return c.json({ success: response.ok }, response.ok ? 200 : 502);
});

// The backend sends each push itself now. A send from an old app would be a
// second push, so this does nothing.
app.post("/send", (c) => c.json({ success: true, sent: 0, details: [] }, 200));

export default app;
