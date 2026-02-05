import Stripe from 'stripe';
import { google } from 'googleapis';
import { buffer } from 'micro';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

// Disable body parsing, need raw body for webhook signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Webhook verified:', event.type);

  // Handle checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      // Get line items from the checkout session
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product']
      });

      console.log('📦 Processing', lineItems.data.length, 'items');

      for (const item of lineItems.data) {
        const quantity = item.quantity;
        
        // Get product ID from metadata (you need to set this when creating Stripe products)
        const product = item.price.product;
        const productId = product.metadata?.productId;

        if (!productId) {
          console.log('⚠️ No productId in metadata for:', product.name);
          continue;
        }

        console.log('🔍 Updating product:', productId, '- Qty:', quantity);

        // Get current inventory from Google Sheet
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: 'A2:G', // Adjust if your columns are different
        });

        const rows = response.data.values || [];
        
        // Find the row with matching productId (column G)
        const rowIndex = rows.findIndex(r => r[6] === productId);

        if (rowIndex === -1) {
          console.log('❌ Product not found in sheet:', productId);
          continue;
        }

        // Get current quantity (column C = index 2)
        const currentQty = parseInt(rows[rowIndex][2], 10) || 0;
        const newQty = Math.max(0, currentQty - quantity);

        // Update the quantity in Google Sheet
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: `C${rowIndex + 2}`, // +2 because: row 1 is headers, arrays are 0-indexed
          valueInputOption: 'RAW',
          requestBody: {
            values: [[newQty]],
          },
        });

        console.log('✅ Updated', productId, ':', currentQty, '→', newQty);
      }

      res.status(200).json({ received: true, message: 'Inventory updated' });
    } catch (error) {
      console.error('❌ Error updating inventory:', error);
      res.status(500).json({ error: 'Failed to update inventory' });
    }
  } else {
    // Return 200 for other event types
    res.status(200).json({ received: true });
  }
}
