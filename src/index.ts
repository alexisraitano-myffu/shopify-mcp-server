#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import dotenv from "dotenv";
import { GraphQLClient } from "graphql-request";
import minimist from "minimist";
import { z } from "zod";
import { Resend } from "resend";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import cookieParser from "cookie-parser";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import tools
import { getCustomerOrders } from "./tools/getCustomerOrders.js";
import { getCustomers } from "./tools/getCustomers.js";
import { getOrderById } from "./tools/getOrderById.js";
import { getOrders } from "./tools/getOrders.js";
import { getProductById } from "./tools/getProductById.js";
import { getProducts } from "./tools/getProducts.js";
import { updateCustomer } from "./tools/updateCustomer.js";
import { updateOrder } from "./tools/updateOrder.js";
import { createProduct } from "./tools/createProduct.js";

// Parse command line arguments
const argv = minimist(process.argv.slice(2));

// Load environment variables from .env file (if it exists)
dotenv.config();

// Define environment variables - from command line or .env file
const SHOPIFY_ACCESS_TOKEN =
  argv.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;
const MYSHOPIFY_DOMAIN = argv.domain || process.env.MYSHOPIFY_DOMAIN;
const PORT = Number(process.env.PORT) || 8080;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DEMO_EMAIL     = process.env.DEMO_EMAIL;
const DEMO_OTP       = process.env.DEMO_OTP;

// Supabase anon client — used only for dashboard (browser-side, injected via window.*)
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

// Supabase admin client — service role key, bypasses RLS, used for all server-side operations
const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function logEvent(payload: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  supabaseAdmin.from('events').insert({ ...payload, shop_domain: process.env.SHOP_DOMAIN }).then(({ error }) => {
    if (error) console.error('[Supabase] insert error:', JSON.stringify(error));
  });
}

// OTP Storage
const otpStorage = new Map<string, { code: string; expires: number }>();
const activeSessions = new Map<string, { email: string; customerId: string; createdAt: number }>();

// Store in process.env for backwards compatibility
process.env.SHOPIFY_ACCESS_TOKEN = SHOPIFY_ACCESS_TOKEN;
process.env.MYSHOPIFY_DOMAIN = MYSHOPIFY_DOMAIN;

// Validate required environment variables
if (!SHOPIFY_ACCESS_TOKEN) {
  console.error("Error: SHOPIFY_ACCESS_TOKEN is required.");
  console.error("Please provide it via command line argument or .env file.");
  console.error("  Command line: --accessToken=your_token");
  process.exit(1);
}

if (!MYSHOPIFY_DOMAIN) {
  console.error("Error: MYSHOPIFY_DOMAIN is required.");
  console.error("Please provide it via command line argument or .env file.");
  console.error("  Command line: --domain=your-store.myshopify.com");
  process.exit(1);
}

if (!RESEND_API_KEY) {
  console.error("Error: RESEND_API_KEY is required.");
  console.error("Please provide it via .env file.");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// Create Shopify GraphQL client
const shopifyClient = new GraphQLClient(
  `https://${MYSHOPIFY_DOMAIN}/admin/api/2025-01/graphql.json`,
  {
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json"
    }
  }
);

// Initialize tools with shopifyClient
getProducts.initialize(shopifyClient);
getProductById.initialize(shopifyClient);
getCustomers.initialize(shopifyClient);
getOrders.initialize(shopifyClient);
getOrderById.initialize(shopifyClient);
updateOrder.initialize(shopifyClient);
getCustomerOrders.initialize(shopifyClient);
updateCustomer.initialize(shopifyClient);
createProduct.initialize(shopifyClient);

// Set up MCP server
const server = new McpServer({
  name: "shopify",
  version: "1.0.0",
  description:
    "MCP Server for Shopify API, enabling interaction with store data through GraphQL API"
});

// Add tools individually, using their schemas directly
server.tool(
  "get-products",
  {
    searchTitle: z.string().optional(),
    limit: z.coerce.number().default(10)
  },
  async (args) => {
    const result = await getProducts.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

server.tool(
  "get-product-by-id",
  {
    productId: z.string().min(1)
  },
  async (args) => {
    const result = await getProductById.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

server.tool(
  "get-customers",
  {
    searchQuery: z.string().optional(),
    limit: z.number().default(10)
  },
  async (args) => {
    const result = await getCustomers.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);


server.tool(
  "request-order-otp",
  {
    email: z.string().email()
  },
  async ({ email }) => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    otpStorage.set(email, { code, expires: Date.now() + 5 * 60 * 1000 }); // 5 minutes

    const { error: resendError } = await resend.emails.send({
        from: "onboarding@resend.dev",
        to: email,
        subject: "Your Shopify Order Access Code",
        html: `<p>Your verification code is: <strong>${code}</strong></p>`
      });

      if (resendError) {
        console.error("Resend error:", resendError);
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to send OTP: ${JSON.stringify(resendError)}` }]
        };
      }

      return {
        content: [{ type: "text", text: `OTP sent to ${email}` }]
      };
  }
);

server.tool(
  "verify-order-otp",
  {
    email: z.string().email(),
    code: z.string()
  },
  async ({ email, code }) => {
    const stored = otpStorage.get(email);
    if (!stored || stored.code !== code || Date.now() > stored.expires) {
      return {
        isError: true,
        content: [{ type: "text", text: "Invalid or expired OTP" }]
      };
    }

    otpStorage.delete(email);
    const token = randomUUID();

    try {
      // Find customer by email to get their orders
      const customerResult = await getCustomers.execute({ searchQuery: `email:${email}`, limit: 1 });
      const customer = customerResult.customers[0];

      if (!customer) {
        activeSessions.set(token, { email, customerId: "", createdAt: Date.now() });
        return {
          content: [{ type: "text", text: JSON.stringify({ token, message: "Verified, but no customer found with this email." }) }]
        };
      }

      // Extract numeric ID from Global ID (gid://shopify/Customer/123456)
      const customerId = customer.id.split('/').pop()!;
      activeSessions.set(token, { email, customerId, createdAt: Date.now() });
      const ordersResult = await getCustomerOrders.execute({ customerId, limit: 10 });

      return {
        content: [{ type: "text", text: JSON.stringify({ token, firstName: customer.firstName, orders: ordersResult.orders }) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ token, message: "Verified, but failed to retrieve orders: " + error }) }]
      };
    }
  }
);

server.tool(
  "get-orders",
  {
    status: z.enum(["any", "open", "closed", "cancelled"]).default("any"),
    limit: z.number().default(10),
    token: z.string().describe("OTP verification token")
  },
  async (args) => {
    const { token, ...rest } = args;
    const session = activeSessions.get(token);

    if (!session) {
      return {
        isError: true,
        content: [{ type: "text", text: "Unauthorized: Invalid token" }]
      };
    }

    // Optional: Check session expiry (e.g. 1 hour)
    if (Date.now() - session.createdAt > 3600 * 1000) {
      activeSessions.delete(token);
      return {
        isError: true,
        content: [{ type: "text", text: "Unauthorized: Token expired" }]
      };
    }

    const result = await getOrders.execute(rest);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Add the getOrderById tool
server.tool(
  "get-order-by-id",
  {
    orderId: z.string().min(1)
  },
  async (args) => {
    const result = await getOrderById.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Add the updateOrder tool
server.tool(
  "update-order",
  {
    id: z.string().min(1),
    tags: z.array(z.string()).optional(),
    email: z.string().email().optional(),
    note: z.string().optional(),
    customAttributes: z
      .array(
        z.object({
          key: z.string(),
          value: z.string()
        })
      )
      .optional(),
    metafields: z
      .array(
        z.object({
          id: z.string().optional(),
          namespace: z.string().optional(),
          key: z.string().optional(),
          value: z.string(),
          type: z.string().optional()
        })
      )
      .optional(),
    shippingAddress: z
      .object({
        address1: z.string().optional(),
        address2: z.string().optional(),
        city: z.string().optional(),
        company: z.string().optional(),
        country: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phone: z.string().optional(),
        province: z.string().optional(),
        zip: z.string().optional()
      })
      .optional()
  },
  async (args) => {
    const result = await updateOrder.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Add the getCustomerOrders tool
server.tool(
  "get-customer-orders",
  {
    token: z.string().describe("OTP verification token"),
    limit: z.coerce.number().default(5)
  },
  async ({ token, limit }) => {
const session = activeSessions.get(token);

    if (!session || Date.now() > session.createdAt + 3600 * 1000) {
      if (session) activeSessions.delete(token);
      logEvent({ event_type: 'token_expired', email: session?.email, success: false, error_code: '401' });
      return {
        isError: true,
        content: [{ type: "text", text: "Session expirée, veuillez vous réauthentifier" }]
      };
    }

    const start = Date.now();
    const result = await getCustomerOrders.execute({ customerId: session.customerId || undefined, email: session.email, limit });
    logEvent({ event_type: 'orders_fetched', email: session.email, success: true, orders_count: result.orders.length, latency_ms: Date.now() - start });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Add the updateCustomer tool
server.tool(
  "update-customer",
  {
    id: z
      .string()
      .regex(/^\d+$/, "Customer ID must be numeric")
      .describe("Shopify customer ID, numeric excluding gid prefix"),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    tags: z.array(z.string()).optional(),
    note: z.string().optional(),
    taxExempt: z.boolean().optional(),
    metafields: z
      .array(
        z.object({
          id: z.string().optional(),
          namespace: z.string().optional(),
          key: z.string().optional(),
          value: z.string(),
          type: z.string().optional()
        })
      )
      .optional()
  },
  async (args) => {
    const result = await updateCustomer.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Add the createProduct tool
server.tool(
  "create-product",
  {
    title: z.string().min(1),
    descriptionHtml: z.string().optional(),
    vendor: z.string().optional(),
    productType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).default("DRAFT"),
  },
  async (args) => {
    const result = await createProduct.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// SAV logging tool — called by Voiceflow's SAV agent to log a support request
server.tool(
  "log-sav-request",
  {
    token: z.string().optional(),
  },
  async ({ token }) => {
    const session = token ? activeSessions.get(token) : null;
    logEvent({ event_type: 'sav_request', email: session?.email || null, success: true });
    return {
      content: [{ type: "text", text: '{"success":true}' }]
    };
  }
);

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Global request logging with response tracking
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Incoming: ${req.method} ${req.url}`);

  res.on("finish", () => {
    console.log(`[${timestamp}] Completed: ${req.method} ${req.url} ${res.statusCode}`);
  });

  next();
});

const mcpSessions = new Map<string, SSEServerTransport>();

app.get("/mcp", async (req, res) => {
  console.log("MCP SSE connection established");
  const transport = new SSEServerTransport("/mcp", res);
  mcpSessions.set(transport.sessionId, transport);
  await server.connect(transport);
  res.on("close", () => {
    console.log(`MCP SSE connection closed: ${transport.sessionId}`);
    mcpSessions.delete(transport.sessionId);
  });
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  console.log(`MCP POST message, sessionId: ${sessionId ?? "none"}`);
  const transport = sessionId ? mcpSessions.get(sessionId) : undefined;
  if (!transport) {
    res.status(503).json({ error: "No active MCP session" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// Add health check route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/", (req, res) => {
  console.log("Health check requested");
  res.status(200).json({ status: "ok" });
});

// REST API Endpoints for OTP
app.post("/api/request-otp", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  // Demo mode — fixed OTP, no email sent
  if (DEMO_EMAIL && DEMO_OTP && email === DEMO_EMAIL) {
    otpStorage.set(email, { code: DEMO_OTP, expires: Date.now() + 5 * 60 * 1000 });
    logEvent({ event_type: 'otp_requested', email });
    res.json({ success: true });
    return;
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStorage.set(email, { code, expires: Date.now() + 5 * 60 * 1000 }); // 5 minutes

  const { error: resendError } = await resend.emails.send({
    from: "onboarding@resend.dev",
    to: email,
    subject: "Your Shopify Order Access Code",
    html: `<p>Your verification code is: <strong>${code}</strong></p>`
  });

  if (resendError) {
    console.error("Resend error:", resendError);
    res.status(500).json({ error: `Failed to send OTP: ${JSON.stringify(resendError)}` });
    return;
  }

  logEvent({ event_type: 'otp_requested', email });
  res.json({ message: `OTP sent to ${email}` });
});

app.post("/api/verify-otp", async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    res.status(400).json({ error: "Email and code are required" });
    return;
  }

  // Demo mode — accept fixed OTP regardless of storage state
  const isDemoVerification = DEMO_EMAIL && DEMO_OTP && email === DEMO_EMAIL && code === DEMO_OTP;
  const stored = otpStorage.get(email);
  if (!isDemoVerification && (!stored || stored.code !== code || Date.now() > stored.expires)) {
    logEvent({ event_type: 'otp_failed', email, success: false });
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }
  if (!isDemoVerification) otpStorage.delete(email);
  const token = randomUUID();

  try {
    // Find customer by email to get their orders
    const customerResult = await getCustomers.execute({ searchQuery: `email:${email}`, limit: 1 });
    const customer = customerResult.customers[0];

    if (!customer) {
      activeSessions.set(token, { email, customerId: "", createdAt: Date.now() });
      logEvent({ event_type: 'otp_verified', email, success: true });
      res.json({ token, message: "Verified, but no customer found with this email." });
      return;
    }

    // Extract numeric ID from Global ID (gid://shopify/Customer/123456)
    const customerId = customer.id.split('/').pop()!;
    activeSessions.set(token, { email, customerId, createdAt: Date.now() });
    const ordersResult = await getCustomerOrders.execute({ customerId, limit: 10 });

    logEvent({ event_type: 'otp_verified', email, success: true });
    res.json({
      token,
      firstName: customer.firstName,
      orders: ordersResult.orders
    });
  } catch (error) {
    res.status(500).json({ token, message: "Verified, but failed to retrieve orders: " + error });
  }
});

// ─── Quota ───────────────────────────────────────────────────────────────────

app.post('/api/start-conversation', async (req, res) => {
  const db = supabaseAdmin;
  if (!db) {
    res.status(503).json({ error: 'Supabase not configured' });
    return;
  }

  const shop = process.env.SHOP_DOMAIN;
  if (!shop) {
    res.status(500).json({ error: 'SHOP_DOMAIN not configured' });
    return;
  }

  const { data: row, error: fetchError } = await db
    .from('quotas')
    .select('*')
    .eq('shop_domain', shop)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    console.error('[Quota] fetch error:', fetchError);
    res.status(500).json({ error: 'quota_fetch_failed' });
    return;
  }

  // No row yet — create it with messages_used = 1 (this call counts)
  if (!row) {
    await db.from('quotas').insert({
      shop_domain: shop,
      messages_used: 1,
      period_start: new Date().toISOString().slice(0, 10),
    });
    logEvent({ event_type: 'conversation_started' });
    res.json({ allowed: 'true' });
    return;
  }

  let currentUsed = row.messages_used;

  // Auto-renew: reset if period_start is from a previous month
  if (row.auto_renew) {
    const periodStart = new Date(row.period_start);
    const now = new Date();
    const isOldMonth =
      periodStart.getFullYear() < now.getFullYear() ||
      periodStart.getMonth() < now.getMonth();

    if (isOldMonth) {
      await db.from('quota_history').insert({
        shop_domain: shop,
        action: 'reset',
        messages_used_before: currentUsed,
      });
      await db.from('quotas').update({
        messages_used: 0,
        period_start: now.toISOString().slice(0, 10),
        updated_at: now.toISOString(),
      }).eq('shop_domain', shop);
      currentUsed = 0;
    }
  }

  if (currentUsed >= row.messages_limit) {
    res.json({
      allowed: 'false',
      message: 'Service temporairement indisponible',
      contact_email: process.env.CONTACT_EMAIL || null,
    });
    return;
  }

  await db.from('quotas').update({
    messages_used: currentUsed + 1,
    updated_at: new Date().toISOString(),
  }).eq('shop_domain', shop);

  logEvent({ event_type: 'conversation_started' });
  res.json({ allowed: 'true' });
});

app.post('/api/log-vente', (req, res) => {
  logEvent({ event_type: 'vente_request', success: true });
  res.json({ success: true });
});

app.post('/api/log-sav', (req, res) => {
  logEvent({ event_type: 'sav_request', success: true });
  res.json({ success: true });
});

app.post('/api/quota-reset', async (req, res) => {
  const db = supabaseAdmin;
  if (!db) {
    res.status(503).json({ error: 'Supabase not configured' });
    return;
  }

  const shop = process.env.SHOP_DOMAIN;
  if (!shop) {
    res.status(500).json({ error: 'SHOP_DOMAIN not configured' });
    return;
  }

  const { data: row, error: fetchError } = await db
    .from('quotas')
    .select('*')
    .eq('shop_domain', shop)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    res.status(500).json({ error: 'quota_fetch_failed' });
    return;
  }

  if (!row) {
    res.json({ reset: false, reason: 'no_quota_row' });
    return;
  }

  if (!row.auto_renew) {
    res.json({ reset: false, reason: 'auto_renew_disabled' });
    return;
  }

  const periodStart = new Date(row.period_start);
  const now = new Date();
  const isOldMonth =
    periodStart.getFullYear() < now.getFullYear() ||
    periodStart.getMonth() < now.getMonth();

  if (!isOldMonth) {
    res.json({ reset: false, reason: 'same_month' });
    return;
  }

  await db.from('quota_history').insert({
    shop_domain: shop,
    action: 'reset',
    messages_used_before: row.messages_used,
  });
  await db.from('quotas').update({
    messages_used: 0,
    period_start: now.toISOString().slice(0, 10),
    updated_at: now.toISOString(),
  }).eq('shop_domain', shop);

  res.json({ reset: true, messages_used_before: row.messages_used });
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

const DASHBOARD_PATH = join(__dirname, '..', 'dashboard', 'index.html');

function loginHtml(error = false): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Navi – Connexion</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans',system-ui,sans-serif;background:#F7F5F2;color:#0F0E0C;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#fff;border:1px solid rgba(15,14,12,0.08);border-radius:16px;padding:40px;width:100%;max-width:360px}
    .logo{font-family:'Instrument Serif',Georgia,serif;font-size:22px;margin-bottom:28px}
    .logo span{color:#E8704A}
    h2{font-size:15px;font-weight:600;margin-bottom:6px}
    p{font-size:13px;color:#6B6860;margin-bottom:24px}
    label{display:block;font-size:11px;font-weight:500;margin-bottom:6px;color:#6B6860;text-transform:uppercase;letter-spacing:0.06em}
    input{width:100%;padding:10px 14px;border:1px solid rgba(15,14,12,0.12);border-radius:8px;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;transition:border-color 0.15s;background:#fff}
    input:focus{border-color:#E8704A}
    button{width:100%;margin-top:16px;padding:12px;background:#E8704A;color:#fff;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.15s}
    button:hover{opacity:0.88}
    .error{background:#FEE2E2;color:#DC2626;font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:16px}
    .footer{margin-top:24px;text-align:center;font-size:11px;color:#B4B2A9}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Navi<span>.</span></div>
    <h2>Accès dashboard</h2>
    <p>Espace réservé aux clients Navi Pro.</p>
    ${error ? '<div class="error">Mot de passe incorrect.</div>' : ''}
    <form method="POST" action="/dashboard/login">
      <label>Mot de passe</label>
      <input type="password" name="password" autofocus required>
      <button type="submit">Accéder au dashboard</button>
    </form>
    <div class="footer">by Myffu Studio</div>
  </div>
</body>
</html>`;
}

app.get('/dashboard/login', (req, res) => {
  res.send(loginHtml(req.query.error === '1'));
});

app.post('/dashboard/login', (req, res) => {
  if (req.body.password !== process.env.DASHBOARD_PASSWORD) {
    return void res.redirect('/dashboard/login?error=1');
  }
  res.cookie('dashboard_session', 'authenticated', {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  });
  res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
  if ((req as any).cookies.dashboard_session !== 'authenticated') {
    return void res.redirect('/dashboard/login');
  }
  const html = readFileSync(DASHBOARD_PATH, 'utf8');
  const injected = html.replace('</head>', `<script>
  window.SUPABASE_URL = '${process.env.SUPABASE_URL}';
  window.SUPABASE_ANON_KEY = '${process.env.SUPABASE_ANON_KEY}';
  window.SHOP_DOMAIN = '${process.env.SHOP_DOMAIN}';
</script>
</head>`);
  res.send(injected);
});

// Serve dashboard static assets (favicon, images) — index: false prevents bypassing auth
app.use('/dashboard', express.static(join(__dirname, '..', 'dashboard'), { index: false }));

// ─────────────────────────────────────────────────────────────────────────────

const serverInstance = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server environment PORT: ${process.env.PORT}`);
  console.log(`Resolved PORT: ${PORT}`);
  console.log(`Shopify MCP Server running on port ${PORT}`);
  console.log(`Listening on IPv4 (0.0.0.0)`);
});

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`Received ${signal}. Closing server...`);
  serverInstance.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });

  // Force exit if close takes too long
  setTimeout(() => {
    console.error("Forcing shutdown...");
    process.exit(1);
  }, 5000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
