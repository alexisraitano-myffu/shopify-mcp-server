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

// OTP Storage
const otpStorage = new Map<string, { code: string; expires: number }>();
const activeSessions = new Map<string, { email: string; createdAt: number }>();

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
  `https://${MYSHOPIFY_DOMAIN}/admin/api/2023-07/graphql.json`,
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
    limit: z.number().default(10)
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

    try {
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: email,
        subject: "Your Shopify Order Access Code",
        html: `<p>Your verification code is: <strong>${code}</strong></p>`
      });
      return {
        content: [{ type: "text", text: `OTP sent to ${email}` }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to send OTP: ${error}` }]
      };
    }
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
    activeSessions.set(token, { email, createdAt: Date.now() });

    try {
      // Find customer by email to get their orders
      const customerResult = await getCustomers.execute({ searchQuery: `email:${email}`, limit: 1 });
      const customer = customerResult.customers[0];

      if (!customer) {
        return {
          content: [{ type: "text", text: JSON.stringify({ token, message: "Verified, but no customer found with this email." }) }]
        };
      }

      // Extract numeric ID from Global ID (gid://shopify/Customer/123456)
      const customerId = customer.id.split('/').pop();
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
    customerId: z
      .string()
      .regex(/^\d+$/, "Customer ID must be numeric")
      .describe("Shopify customer ID, numeric excluding gid prefix"),
    limit: z.number().default(10)
  },
  async (args) => {
    const result = await getCustomerOrders.execute(args);
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

// Initialize Express app
const app = express();

// Global request logging with response tracking
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Incoming: ${req.method} ${req.url}`);

  res.on("finish", () => {
    console.log(`[${timestamp}] Completed: ${req.method} ${req.url} ${res.statusCode}`);
  });

  next();
});

let activeTransport: SSEServerTransport | null = null;

app.get("/sse", async (req, res) => {
  console.log("New SSE connection established");
  activeTransport = new SSEServerTransport("/messages", res);
  await server.connect(activeTransport);

  res.on("close", () => {
    console.log("SSE connection closed");
    activeTransport = null;
  });
});

app.post("/messages", async (req, res) => {
  console.log("Received message");

  if (!activeTransport) {
    res.status(503).send("No active SSE connection");
    return;
  }

  try {
    await activeTransport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error handling message:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Add health check route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/", (req, res) => {
  console.log("Health check requested");
  res.status(200).json({ status: "ok" });
});

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
