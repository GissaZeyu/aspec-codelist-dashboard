require("dotenv").config();
const express = require("express");
const serverless = require("serverless-http");
const sgMail = require("@sendgrid/mail");

const DEFAULT_FROM = process.env.EMAIL_DEFAULT_FROM || "noreply@example.com";
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;

if (!SENDGRID_KEY) {
  console.warn("[WARN] SENDGRID_API_KEY is not set. Emails will fail until it is provided.");
} else {
  sgMail.setApiKey(SENDGRID_KEY);
}

const app = express();
app.use(express.json({ limit: "25mb" }));

// CORS - allow all origins for Netlify deployment
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Health check
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /api/send-codelist-email
 * Body: {
 *   to: string | string[],
 *   from?: string,
 *   replyTo?: string,
 *   subject: string,
 *   html: string,
 *   xlsxBase64?: string,
 *   filename?: string,
 *   cc?: string | string[],
 *   bcc?: string | string[],
 *   imageAttachments?: Array<{filename:string,type:string,content:string}>
 * }
 */
app.post("/api/send-codelist-email", async (req, res) => {
  try {
    const {
      to,
      from,
      replyTo,
      subject,
      html,
      xlsxBase64,
      filename = "codelist.xlsx",
      cc,
      bcc,
      imageAttachments = [],
    } = req.body || {};

    if (!to || !subject || !html) {
      return res.status(400).json({ 
        ok: false, 
        error: "Missing required fields (to, subject, html)" 
      });
    }

    // Server-side checks: never rely solely on browser-side file validation.
    const IMAGE_MIMES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const MAX_EACH = 1536 * 1024;
    const MAX_COMBINED = 3 * 1024 * 1024;
    if (!Array.isArray(imageAttachments) || imageAttachments.length > 20) {
      return res.status(400).json({ok:false,error:"Invalid image attachment list"});
    }
    let combinedBytes = 0;
    const verifiedImages = [];
    for (const image of imageAttachments) {
      if (!image || !Object.prototype.hasOwnProperty.call(IMAGE_MIMES, image.type)
          || typeof image.content !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.content)) {
        return res.status(400).json({ok:false,error:"Images must be JPG, PNG or WebP"});
      }
      const bytes = Buffer.from(image.content, "base64");
      const validSignature = image.type === "image/jpeg"
        ? bytes.length >= 3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff
        : image.type === "image/png"
          ? bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          : bytes.length >= 12 && bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP";
      if (!validSignature || bytes.length === 0 || bytes.length > MAX_EACH) {
        return res.status(400).json({ok:false,error:"Invalid or oversized supporting image"});
      }
      combinedBytes += bytes.length;
      if (combinedBytes > MAX_COMBINED) {
        return res.status(400).json({ok:false,error:"Supporting images exceed the 3 MB combined limit"});
      }
      const safeName = String(image.filename || "supporting-image")
        .replace(/[^A-Za-z0-9._-]/g, "_").slice(0,140);
      verifiedImages.push({
        content: bytes.toString("base64"), filename: safeName,
        type: image.type, disposition:"attachment"
      });
    }

    const msg = {
      to,
      from: from || DEFAULT_FROM,
      subject,
      html,
      replyTo: replyTo || from || DEFAULT_FROM,
      cc,
      bcc,
      categories: ["codelist-dashboard"],
    };

    // Add attachment only if provided
    if (xlsxBase64 && typeof xlsxBase64 === "string") {
      msg.attachments = [
        {
          content: xlsxBase64,
          filename,
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          disposition: "attachment",
        },
      ];
    }
    if (verifiedImages.length) msg.attachments = [...(msg.attachments || []), ...verifiedImages];

    const [sgResp] = await sgMail.send(msg);
    return res.status(200).json({ ok: true, status: sgResp.statusCode });
  } catch (err) {
    const sgErr = err?.response?.body || err;
    console.error("SendGrid error:", sgErr);
    return res.status(502).json({
      ok: false,
      error: sgErr?.errors?.[0]?.message || "Email send failed",
    });
  }
});

// Root endpoint
app.get("/", (_req, res) => {
  res.type("text/plain").send("Email API is running. POST /api/send-codelist-email");
});

// Export for Netlify Functions
module.exports.handler = serverless(app);