const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./repair_intel.db');

// Initialize database
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    property_address TEXT,
    payment_id TEXT,
    payment_amount REAL,
    report_data TEXT,
    termites_mentioned BOOLEAN,
    pests_mentioned BOOLEAN,
    rot_mentioned BOOLEAN,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// File upload setup
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// API Routes
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Repair Intel Report',
            description: 'AI-Powered Home Inspection Cost Analysis'
          },
          unit_amount: parseInt(process.env.REPORT_PRICE || 4999)
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel`
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/process-report', upload.single('pdf'), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, propertyAddress } = req.body;
    const pdfBuffer = req.file.buffer;

    // Parse PDF
    const pdfData = await pdfParse(pdfBuffer);
    const pdfText = pdfData.text;

    // Analyze with Anthropic
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Analyze this home inspection report and create repair cost estimates.
        
Return JSON with this structure:
{
  "repair_categories": [
    {
      "category_name": "string",
      "inspection_items": [{"section_number": "string", "description": "string"}],
      "handyman_cost": number,
      "contractor_cost": number,
      "recommended_trade": "string"
    }
  ],
  "termites_mentioned": boolean,
  "pests_mentioned": boolean,
  "rot_mentioned": boolean
}

Inspection text: ${pdfText.substring(0, 40000)}`
      }]
    });

    const analysis = JSON.parse(message.content[0].text);

    // Generate PDF report text
    const reportText = generateReportText(firstName, lastName, propertyAddress, analysis);

    // Save to database
    db.run(`INSERT INTO reports (first_name, last_name, email, phone, property_address, report_data, termites_mentioned, pests_mentioned, rot_mentioned)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [firstName, lastName, email, phone, propertyAddress, JSON.stringify(analysis), 
       analysis.termites_mentioned, analysis.pests_mentioned, analysis.rot_mentioned]);

    // Send emails
    await sendClientEmail(email, firstName, propertyAddress, reportText);
    await sendAdminEmail(firstName, lastName, email, phone, propertyAddress, analysis);
    
    if (analysis.termites_mentioned || analysis.pests_mentioned) {
      await sendGreenMantisEmail(firstName, lastName, email, phone, propertyAddress, analysis);
    }

    res.json({ success: true, report: reportText });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

function generateReportText(firstName, lastName, propertyAddress, analysis) {
  let report = `═══════════════════════════════════════════
         THE REPAIR INTEL
   COST ANALYSIS INTELLIGENCE REPORT
═══════════════════════════════════════════

PREPARED FOR:      ${firstName} ${lastName}
PROPERTY ADDRESS:  ${propertyAddress}
DATE PREPARED:     ${new Date().toLocaleDateString()}
PREPARED BY:       Anarumo Inspection Services

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXECUTIVE SUMMARY

This intelligence report provides repair cost estimates 
based on your home inspection findings. Costs are shown 
as HANDYMAN to CONTRACTOR ranges.

═══════════════════════════════════════════

`;

  analysis.repair_categories.forEach((cat, idx) => {
    report += `${cat.category_name}\n\n`;
    report += `Estimated Range: Handyman to Contractor\n`;
    report += `  Handyman Cost:   $${cat.handyman_cost.toLocaleString()}\n`;
    report += `  Contractor Cost: $${cat.contractor_cost.toLocaleString()}\n\n`;
    report += `Referenced inspection items:\n`;
    cat.inspection_items.forEach(item => {
      report += `  • Section ${item.section_number} – ${item.description}\n`;
    });
    report += `\nRecommended Trade: ${cat.recommended_trade}\n`;
    
    if (idx < analysis.repair_categories.length - 1) {
      report += `\n───────────────────────────────────────────\n\n`;
    }
  });

  const totalHandyman = analysis.repair_categories.reduce((sum, cat) => sum + cat.handyman_cost, 0);
  const totalContractor = analysis.repair_categories.reduce((sum, cat) => sum + cat.contractor_cost, 0);

  report += `\n═══════════════════════════════════════════

TOTAL ESTIMATED REPAIR RANGE

Handyman Total:   $${totalHandyman.toLocaleString()}
Contractor Total: $${totalContractor.toLocaleString()}

Note: These estimates are for negotiation context only.

═══════════════════════════════════════════
© ${new Date().getFullYear()} The Repair Intel
`;

  return report;
}

async function sendClientEmail(email, name, address, reportText) {
  await transporter.sendMail({
    from: `"The Repair Intel" <${process.env.FROM_EMAIL}>`,
    to: email,
    subject: `Your Repair Intel Report - ${address}`,
    html: `<h2>Hi ${name},</h2>
           <p>Your Repair Intel report for ${address} is ready!</p>
           <p>See attached PDF.</p>
           <p>Best,<br>The Repair Intel Team</p>`,
    attachments: [{
      filename: 'RepairIntel_Report.txt',
      content: reportText
    }]
  });
}

async function sendAdminEmail(firstName, lastName, email, phone, address, analysis) {
  await transporter.sendMail({
    from: `"The Repair Intel" <${process.env.FROM_EMAIL}>`,
    to: process.env.FROM_EMAIL,
    subject: `✅ New Report Generated - $49.99`,
    html: `<h3>NEW CUSTOMER</h3>
           <p><strong>Name:</strong> ${firstName} ${lastName}</p>
           <p><strong>Email:</strong> ${email}</p>
           <p><strong>Phone:</strong> ${phone}</p>
           <p><strong>Property:</strong> ${address}</p>`
  });
}

async function sendGreenMantisEmail(firstName, lastName, email, phone, address, analysis) {
  await transporter.sendMail({
    from: `"The Repair Intel" <${process.env.FROM_EMAIL}>`,
    to: process.env.ADMIN_EMAIL,
    subject: `🐜 Pest Lead - ${address}`,
    html: `<h3>NEW PEST OPPORTUNITY</h3>
           <p><strong>Client:</strong> ${firstName} ${lastName}</p>
           <p><strong>Phone:</strong> ${phone}</p>
           <p><strong>Email:</strong> ${email}</p>
           <p><strong>Property:</strong> ${address}</p>
           <p><strong>Findings:</strong> Pest/termite activity detected</p>`
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});