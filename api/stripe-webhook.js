import Stripe from 'stripe';
import { google } from 'googleapis';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const privateKey = process.env.GOOGLE_PRIVATE_KEY.includes('\\n')
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : process.env.GOOGLE_PRIVATE_KEY;

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  privateKey,
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    console.log('=== CHECKOUT COMPLETED ===');
    console.log('Session ID:', session.id);
    console.log('Metadata:', session.metadata);

    try {
      const items = JSON.parse(session.metadata.items || '[]');

      // Get current sheet data
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A:G'
      });

      const rows = response.data.values || [];
      const data = rows.slice(1);

      // Column G is ProductId (index 6)
      // Column C is Quantity (index 2)
      const productIdIndex = 6;
      const quantityIndex = 2;

      // Update inventory for each item
      for (const item of items) {
        const productId = item.productId;
        const quantityPurchased = parseInt(item.qty);

        console.log(`Updating inventory for ${productId}: -${quantityPurchased}`);

        // Find the row index (add 2 because: 1 for header, 1 for 0-based to 1-based)
        const dataRowIndex = data.findIndex(row => row[productIdIndex] === productId);

        if (dataRowIndex === -1) {
          console.error(`Product ${productId} not found in sheet`);
          continue;
        }

        const sheetRowNumber = dataRowIndex + 2; // +1 for header, +1 for 1-based indexing
        const currentQuantity = parseInt(data[dataRowIndex][quantityIndex]) || 0;
        const newQuantity = Math.max(0, currentQuantity - quantityPurchased);

        console.log(`  Current: ${currentQuantity}, New: ${newQuantity}`);

        // Update the quantity in column C
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: `Sheet1!C${sheetRowNumber}`, // Column C
          valueInputOption: 'RAW',
          requestBody: {
            values: [[newQuantity]]
          }
        });

        console.log(`✓ Updated ${productId} inventory: ${currentQuantity} → ${newQuantity}`);
      }

      console.log('=== INVENTORY UPDATE COMPLETE ===');
    } catch (error) {
      console.error('Error updating inventory:', error);
      // Don't fail the webhook - just log the error
    }
  }

  res.status(200).json({ received: true });
}
