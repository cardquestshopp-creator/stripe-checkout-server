import { google } from 'googleapis';

const privateKey = process.env.GOOGLE_PRIVATE_KEY.includes('\\n')
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : process.env.GOOGLE_PRIVATE_KEY;

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  privateKey,
  ['https://www.googleapis.com/auth/spreadsheets.readonly']
);

const sheets = google.sheets({ version: 'v4', auth });

export default async function handler(req, res) {
  const { category, tcg } = req.query;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:G', // Read columns A through G
    });

    const rows = response.data.values || [];
    
    if (rows.length === 0) {
      return res.status(200).json([]);
    }

    const headers = rows[0];
    const data = rows.slice(1);

    // Convert to JSON using column indexes
    let products = data.map(row => ({
      productName: row[0],     // Column A - Product Name
      price: row[1],           // Column B - Price
      quantity: row[2],        // Column C - Quantity
      condition: row[3],       // Column D - Condition
      category: row[4],        // Column E - Category
      tcg: row[5],             // Column F - TCG
      productId: row[6],       // Column G - ProductId
    })).filter(item => parseInt(item.quantity || 0) > 0); // Only in-stock items

    // Filter by category if provided
    if (category) {
      products = products.filter(item => 
        item.category && item.category.toLowerCase() === category.toLowerCase()
      );
    }

    // Filter by TCG if provided
    if (tcg) {
      products = products.filter(item => 
        item.tcg && item.tcg.toLowerCase() === tcg.toLowerCase()
      );
    }

    res.status(200).json(products);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
}
