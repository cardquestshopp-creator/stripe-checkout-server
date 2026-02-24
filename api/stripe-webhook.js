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
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET environment variable');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

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
    console.log('Amount paid:', session.amount_total);
    console.log('Metadata:', session.metadata);

    try {
      // Parse items from metadata
      let items = [];
      if (session.metadata && session.metadata.items) {
        try {
          items = JSON.parse(session.metadata.items);
        } catch (parseError) {
          console.error('Failed to parse metadata items:', parseError);
          items = [];
        }
      }

      if (!items || items.length === 0) {
        console.log('No items in metadata, skipping inventory update');
        return res.status(200).json({ received: true, message: 'No items to update' });
      }

      console.log('Processing items:', items);

      // Get current sheet data
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A:Z'
      });

      const rows = response.data.values || [];
      
      if (rows.length === 0) {
        console.error('Sheet is empty');
        return res.status(200).json({ received: true, error: 'Empty sheet' });
      }

      // Find column indexes dynamically
      const headers = rows[0].map(h => (h || '').toLowerCase().trim());
      const data = rows.slice(1);

      console.log('Sheet headers:', headers);

      // Find ProductId column
      const productIdIndex = headers.findIndex(h => 
        h === 'productid' || h === 'product_id' || h === 'sku' || h === 'id'
      );

      // Find Quantity column
      const quantityIndex = headers.findIndex(h => 
        h === 'quantity' || h === 'qty' || h === 'stock'
      );

      console.log(`Found columns - ProductId: ${productIdIndex}, Quantity: ${quantityIndex}`);

      if (productIdIndex === -1 || quantityIndex === -1) {
        console.error('Required columns not found');
        console.error('Available headers:', headers);
        return res.status(200).json({ 
          received: true, 
          error: 'Missing required columns' 
        });
      }

      // Update inventory for each item
      const updates = [];
      
      for (const item of items) {
        const productId = item.productId;
        const quantityPurchased = parseInt(item.qty) || 1;

        console.log(`\nProcessing: ${productId}, qty purchased: ${quantityPurchased}`);

        // Find the product row
        const dataRowIndex = data.findIndex(row => {
          const rowProductId = (row[productIdIndex] || '').toString().trim();
          return rowProductId === productId;
        });

        if (dataRowIndex === -1) {
          console.error(`Product ${productId} not found in sheet`);
          continue;
        }

        const sheetRowNumber = dataRowIndex + 2;
        const currentQuantity = parseInt(data[dataRowIndex][quantityIndex]) || 0;
        const newQuantity = Math.max(0, currentQuantity - quantityPurchased);

        console.log(`  Row: ${sheetRowNumber}, Current: ${currentQuantity}, New: ${newQuantity}`);

        // Update the quantity
        const columnLetter = String.fromCharCode(65 + quantityIndex);
        
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: `Sheet1!${columnLetter}${sheetRowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [[newQuantity]]
          }
        });

        updates.push({ productId, currentQuantity, newQuantity });
        console.log(`✓ Updated ${productId}`);
      }

      console.log('\n=== INVENTORY UPDATE COMPLETE ===');
      console.log('Updates:', updates);
      
      return res.status(200).json({ 
        received: true, 
        message: 'Inventory updated successfully',
        updates: updates
      });
      
    } catch (error) {
      console.error('Error updating inventory:', error);
      console.error('Error stack:', error.stack);
      // Still return 200 to Stripe so it doesn't retry
      return res.status(200).json({ 
        received: true, 
        error: 'Inventory update failed but checkout completed' 
      });
    }
  }

  // Handle checkout.session.expired
  if (event.type === 'checkout.session.expired') {
    console.log('Checkout session expired');
  }

  res.status(200).json({ received: true });
}
