import { google } from 'googleapis';

const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

export default async function handler(req, res) {
  const { sku, quantity = 1 } = req.query;

  if (!sku) {
    return res.status(400).json({ error: 'Missing SKU' });
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'A2:D',
  });

  const rows = response.data.values || [];
  const row = rows.find(r => r[0] === sku);

  const stock = row ? parseInt(row[2], 10) : 0;

  res.status(200).json({
    inStock: stock >= quantity,
    remaining: stock
  });
}
