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

      // Get current sheet data with ALL columns
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A:Z' // Get all possible columns
      });

      const rows = response.data.values || [];
      
      if (rows.length === 0) {
        console.error('Sheet is empty');
        return res.status(200).json({ received: true, error: 'Empty sheet' });
      }

      // Dynamically find column indexes (case-insensitive)
      const headers = rows[0].map(h => (h || '').toLowerCase().trim());
      const data = rows.slice(1);

      console.log('Sheet headers:', headers);

      // Find ProductId column (try multiple possible names)
      const productIdIndex = headers.findIndex(h => 
        h === 'productid' || h === 'product_id' || h === 'sku' || h === 'id'
      );

      // Find Quantity column (try multiple possible names)
      const quantityIndex = headers.findIndex(h => 
        h === 'quantity' || h === 'qty' || h === 'stock'
      );

      console.log(`Found columns - ProductId: ${productIdIndex}, Quantity: ${quantityIndex}`);

      if (productIdIndex === -1 || quantityIndex === -1) {
        console.error('Required columns not found in sheet');
        console.error('Headers found:', headers);
        return res.status(200).json({ 
          received: true, 
          error: 'Missing required columns' 
        });
      }

      // Update inventory for each item
      for (const item of items) {
        const productId = item.productId;
        const quantityPurchased = parseInt(item.qty);

        console.log(`Looking for productId: ${productId}, purchased: ${quantityPurchased}`);

        // Find the product row by productId
        const dataRowIndex = data.findIndex(row => {
          const rowProductId = (row[productIdIndex] || '').toString().trim();
          return rowProductId === productId;
        });

        if (dataRowIndex === -1) {
          console.error(`Product ${productId} not found in sheet`);
          console.error('Available productIds:', data.map(row => row[productIdIndex]));
          continue;
        }

        const sheetRowNumber = dataRowIndex + 2; // +1 for header, +1 for 1-based indexing
        const currentQuantity = parseInt(data[dataRowIndex][quantityIndex]) || 0;
        const newQuantity = Math.max(0, currentQuantity - quantityPurchased);

        console.log(`  Product: ${productId}`);
        console.log(`  Row: ${sheetRowNumber}`);
        console.log(`  Current: ${currentQuantity}, Purchased: ${quantityPurchased}, New: ${newQuantity}`);

        // Convert column index to letter (A=0, B=1, C=2, etc.)
        const columnLetter = String.fromCharCode(65 + quantityIndex);
        const updateRange = `Sheet1!${columnLetter}${sheetRowNumber}`;

        console.log(`  Updating range: ${updateRange}`);

        // Update the quantity
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: updateRange,
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
      console.error('Error stack:', error.stack);
      // Don't fail the webhook - just log the error
    }
  }

  res.status(200).json({ received: true });
}
