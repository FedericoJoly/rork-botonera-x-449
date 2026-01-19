import { Transaction, Product, AppSettings, ExchangeRates, ProductType } from '@/types/sales';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import * as XLSX from 'xlsx';

interface ExportData {
  userName: string;
  eventName: string;
  transactions: Transaction[];
  products: Product[];
  productTypes: ProductType[];
  settings: AppSettings;
  exchangeRates: ExchangeRates;
}

function getRate(exchangeRates: ExchangeRates, currency: string): number {
  if (currency === 'USD') return exchangeRates.USD;
  if (currency === 'EUR') return exchangeRates.EUR;
  if (currency === 'GBP') return exchangeRates.GBP;
  return 1;
}

interface GoogleSheetsExportOptions {
  folderId?: string;
  folderLink?: string;
  shareWithEmail?: string;
}

function base64UrlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createJWT(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const privateKeyPem = serviceAccount.private_key;
  const pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const encoder = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(signatureInput)
  );

  const signatureArray = new Uint8Array(signatureBuffer);
  let binaryString = '';
  for (let i = 0; i < signatureArray.length; i++) {
    binaryString += String.fromCharCode(signatureArray[i]);
  }
  const signature = base64UrlEncode(binaryString);

  return `${signatureInput}.${signature}`;
}

async function getServiceAccountAccessToken(): Promise<string> {
  const serviceAccountJson = process.env.EXPO_PUBLIC_GOOGLE_SERVICE_ACCOUNT;
  
  if (!serviceAccountJson) {
    throw new Error('Service account not configured. Please set EXPO_PUBLIC_GOOGLE_SERVICE_ACCOUNT environment variable.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('Invalid service account JSON format');
  }

  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Service account missing required fields (client_email, private_key)');
  }

  console.log('🔐 Creating JWT for service account:', serviceAccount.client_email);
  
  const jwt = await createJWT(serviceAccount);
  
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('❌ Token exchange failed:', errorText);
    throw new Error(`Failed to get access token: ${errorText}`);
  }

  const tokenData = await tokenResponse.json();
  console.log('✅ Got access token from service account');
  return tokenData.access_token;
}

export function getServiceAccountEmail(): string | null {
  try {
    const serviceAccountJson = process.env.EXPO_PUBLIC_GOOGLE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) return null;
    const serviceAccount = JSON.parse(serviceAccountJson);
    return serviceAccount.client_email || null;
  } catch {
    return null;
  }
}

function extractFolderIdFromLink(link: string): string | null {
  console.log('📁 Extracting folder ID from link:', link);
  
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];
  
  for (const pattern of patterns) {
    const match = link.match(pattern);
    if (match && match[1]) {
      console.log('✅ Extracted folder ID:', match[1]);
      return match[1];
    }
  }
  
  console.log('❌ Could not extract folder ID from link');
  return null;
}

function generateRegistryData(data: ExportData): { rows: (string | number)[][], productNames: string[] } {
  const allProductNames = new Set<string>();
  data.transactions.forEach(transaction => {
    transaction.items.forEach(item => {
      allProductNames.add(item.product.name);
    });
  });
  
  // Create a map of product name to product for sorting
  const productMap = new Map<string, Product>();
  data.products.forEach(product => {
    productMap.set(product.name, product);
  });
  
  // Create a map of type id to type order
  const typeOrderMap = new Map<string, number>();
  data.productTypes.forEach(type => {
    typeOrderMap.set(type.id, type.order);
  });
  
  // Sort product names by type order first, then by product order within type
  const productNames = Array.from(allProductNames).sort((a, b) => {
    const productA = productMap.get(a);
    const productB = productMap.get(b);
    
    if (!productA || !productB) {
      return a.localeCompare(b);
    }
    
    const typeOrderA = typeOrderMap.get(productA.typeId) ?? 999;
    const typeOrderB = typeOrderMap.get(productB.typeId) ?? 999;
    
    if (typeOrderA !== typeOrderB) {
      return typeOrderA - typeOrderB;
    }
    
    return productA.order - productB.order;
  });

  const headers = [
    'Transaction ID', 'Date', 'Time',
    ...productNames,
    'Subtotal', 'Discount', 'Total', 'Currency', 'Payment Method', 'Email', 'Promotions'
  ];
  const rows: (string | number)[][] = [headers];

  const sortedTransactions = [...data.transactions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  sortedTransactions.forEach(transaction => {
    const date = new Date(transaction.timestamp);
    
    const productQuantities: Map<string, number> = new Map();
    transaction.items.forEach(item => {
      productQuantities.set(item.product.name, item.quantity);
    });

    const productColumns = productNames.map(name => {
      const qty = productQuantities.get(name);
      return qty !== undefined ? qty : '';
    });

    rows.push([
      transaction.id,
      date.toLocaleDateString(),
      date.toLocaleTimeString(),
      ...productColumns,
      transaction.subtotal,
      transaction.discount,
      transaction.total,
      transaction.currency,
      transaction.paymentMethod,
      transaction.email || '',
      transaction.appliedPromotions.join('; '),
    ]);
  });

  return { rows, productNames };
}

function generateProductsData(data: ExportData): { rows: (string | number)[][], totalRowIndex: number } {
  const mainCurrency = data.settings.currency;
  const headers = ['Product', 'Subgroup', 'Quantity Sold', `Total Amount (${mainCurrency})`];
  const rows: (string | number)[][] = [headers];

  const productSales = new Map<string, { product: Product; quantity: number; amount: number }>();

  data.transactions.forEach(transaction => {
    const fromRate = getRate(data.exchangeRates, transaction.currency);
    const toRate = getRate(data.exchangeRates, mainCurrency);
    const conversionRate = toRate / fromRate;

    transaction.items.forEach(item => {
      const existing = productSales.get(item.product.id);
      const convertedAmount = item.product.price * item.quantity * conversionRate;

      if (existing) {
        existing.quantity += item.quantity;
        existing.amount += convertedAmount;
      } else {
        productSales.set(item.product.id, {
          product: item.product as Product,
          quantity: item.quantity,
          amount: convertedAmount,
        });
      }
    });
  });

  let totalAmount = 0;
  Array.from(productSales.values())
    .sort((a, b) => b.amount - a.amount)
    .forEach(({ product, quantity, amount }) => {
      totalAmount += amount;
      rows.push([
        product.name,
        product.subgroup || '',
        quantity,
        Math.round(amount * 100) / 100,
      ]);
    });

  rows.push(['', '', 'TOTAL', Math.round(totalAmount * 100) / 100]);

  return { rows, totalRowIndex: rows.length - 1 };
}

function generateCurrenciesData(data: ExportData): (string | number)[][] {
  const headers = ['Currency', 'Payment Method', 'Transactions', 'Total Amount'];
  const rows: (string | number)[][] = [headers];

  const currencySummary = new Map<string, Map<string, { count: number; total: number }>>();

  data.transactions.forEach(transaction => {
    const currency = transaction.currency;
    const method = transaction.paymentMethod;

    if (!currencySummary.has(currency)) {
      currencySummary.set(currency, new Map());
    }

    const currencyMethods = currencySummary.get(currency)!;
    const existing = currencyMethods.get(method);

    if (existing) {
      existing.count += 1;
      existing.total += transaction.total;
    } else {
      currencyMethods.set(method, {
        count: 1,
        total: transaction.total,
      });
    }
  });

  currencySummary.forEach((methods, currency) => {
    methods.forEach((methodData, method) => {
      rows.push([
        currency,
        method,
        methodData.count,
        Math.round(methodData.total * 100) / 100,
      ]);
    });
  });

  return rows;
}

export async function exportToGoogleSheets(
  data: ExportData,
  options: GoogleSheetsExportOptions
): Promise<{ success: boolean; error?: string; spreadsheetUrl?: string }> {
  console.log('📊 Starting Google Sheets export with Service Account...');
  
  let accessToken: string;
  try {
    accessToken = await getServiceAccountAccessToken();
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to authenticate with service account',
    };
  }
  
  let folderId = options.folderId;
  if (!folderId && options.folderLink) {
    folderId = extractFolderIdFromLink(options.folderLink) || undefined;
  }
  
  try {
    const timestamp = new Date().toISOString().split('T')[0];
    const safeName = data.eventName.replace(/[^a-z0-9]/gi, '_');
    const spreadsheetTitle = `${safeName}_${timestamp}`;
    
    console.log('📄 Creating spreadsheet:', spreadsheetTitle);
    
    const { rows: registryRows } = generateRegistryData(data);
    const { rows: productsRows } = generateProductsData(data);
    const currenciesData = generateCurrenciesData(data);
    
    const createResponse = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          title: spreadsheetTitle,
        },
        sheets: [
          {
            properties: { title: 'Registry', index: 0 },
            data: [{
              startRow: 0,
              startColumn: 0,
              rowData: registryRows.map((row: (string | number)[]) => ({
                values: row.map((cell: string | number) => ({
                  userEnteredValue: typeof cell === 'number' 
                    ? { numberValue: cell }
                    : { stringValue: String(cell) }
                }))
              }))
            }]
          },
          {
            properties: { title: 'Products Summary', index: 1 },
            data: [{
              startRow: 0,
              startColumn: 0,
              rowData: productsRows.map((row: (string | number)[]) => ({
                values: row.map((cell: string | number) => ({
                  userEnteredValue: typeof cell === 'number' 
                    ? { numberValue: cell }
                    : { stringValue: String(cell) }
                }))
              }))
            }]
          },
          {
            properties: { title: 'Currencies Summary', index: 2 },
            data: [{
              startRow: 0,
              startColumn: 0,
              rowData: currenciesData.map(row => ({
                values: row.map(cell => ({
                  userEnteredValue: typeof cell === 'number' 
                    ? { numberValue: cell }
                    : { stringValue: String(cell) }
                }))
              }))
            }]
          }
        ]
      }),
    });
    
    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error('❌ Failed to create spreadsheet:', errorText);
      throw new Error(`Failed to create spreadsheet: ${errorText}`);
    }
    
    const spreadsheet = await createResponse.json();
    const spreadsheetId = spreadsheet.spreadsheetId;
    const spreadsheetUrl = spreadsheet.spreadsheetUrl;
    
    console.log('✅ Spreadsheet created:', spreadsheetId);
    
    if (folderId) {
      console.log('📁 Moving to folder:', folderId);
      
      const moveResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${folderId}&fields=id,parents`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
      
      if (!moveResponse.ok) {
        const errorText = await moveResponse.text();
        console.error('⚠️ Failed to move spreadsheet to folder:', errorText);
      } else {
        console.log('✅ Spreadsheet moved to folder successfully');
      }
    }

    if (options.shareWithEmail) {
      console.log('📤 Sharing spreadsheet with:', options.shareWithEmail);
      
      const shareResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'user',
            role: 'writer',
            emailAddress: options.shareWithEmail,
          }),
        }
      );
      
      if (!shareResponse.ok) {
        const errorText = await shareResponse.text();
        console.error('⚠️ Failed to share spreadsheet:', errorText);
      } else {
        console.log('✅ Spreadsheet shared successfully');
      }
    }
    
    return { 
      success: true, 
      spreadsheetUrl,
    };
  } catch (error: any) {
    console.error('❌ Error exporting to Google Sheets:', error);
    return { 
      success: false, 
      error: error.message || String(error),
    };
  }
}

export async function createAndExportSpreadsheet(
  data: ExportData
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('📊 Creating Excel spreadsheet...');
    console.log('📝 Export data:', {
      userName: data.userName,
      eventName: data.eventName,
      transactionsCount: data.transactions.length,
      productsCount: data.products.length,
    });

    const workbook = XLSX.utils.book_new();

    const { rows: registryRows, productNames } = generateRegistryData(data);
    const registrySheet = XLSX.utils.aoa_to_sheet(registryRows);
    
    const registryCols = [
      { wch: 36 },
      { wch: 12 },
      { wch: 10 },
      ...productNames.map(() => ({ wch: 12 })),
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 15 },
      { wch: 25 },
      { wch: 20 },
    ];
    registrySheet['!cols'] = registryCols;
    
    const registryHeaderCount = registryRows[0].length;
    for (let col = 0; col < registryHeaderCount; col++) {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
      if (registrySheet[cellRef]) {
        registrySheet[cellRef].s = {
          font: { bold: true },
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      }
    }
    registrySheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    
    XLSX.utils.book_append_sheet(workbook, registrySheet, 'Registry');

    const { rows: productsRows, totalRowIndex } = generateProductsData(data);
    const productsSheet = XLSX.utils.aoa_to_sheet(productsRows);
    productsSheet['!cols'] = [
      { wch: 30 },
      { wch: 20 },
      { wch: 15 },
      { wch: 20 },
    ];
    
    for (let col = 0; col < 4; col++) {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: col });
      if (productsSheet[cellRef]) {
        productsSheet[cellRef].s = {
          font: { bold: true },
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      }
    }
    
    const totalLabelRef = XLSX.utils.encode_cell({ r: totalRowIndex, c: 2 });
    const totalValueRef = XLSX.utils.encode_cell({ r: totalRowIndex, c: 3 });
    if (productsSheet[totalLabelRef]) {
      productsSheet[totalLabelRef].s = { font: { bold: true } };
    }
    if (productsSheet[totalValueRef]) {
      productsSheet[totalValueRef].s = { font: { bold: true } };
    }
    
    productsSheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    
    XLSX.utils.book_append_sheet(workbook, productsSheet, 'Products Summary');

    const currenciesData = generateCurrenciesData(data);
    const currenciesSheet = XLSX.utils.aoa_to_sheet(currenciesData);
    currenciesSheet['!cols'] = [
      { wch: 12 },
      { wch: 15 },
      { wch: 15 },
      { wch: 15 },
    ];
    XLSX.utils.book_append_sheet(workbook, currenciesSheet, 'Currencies Summary');

    const timestamp = new Date().toISOString().split('T')[0];
    const safeName = data.eventName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `${safeName}_${timestamp}.xlsx`;

    const xlsxData = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });

    if (Platform.OS === 'web') {
      const binaryString = atob(xlsxData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      console.log('✅ Excel file downloaded on web');
      return { success: true };
    }

    const binaryString = atob(xlsxData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const file = new File(Paths.cache, fileName);
    file.write(bytes);
    console.log('📄 Excel file created at:', file.uri);

    const isAvailable = await Sharing.isAvailableAsync();
    if (!isAvailable) {
      return { success: false, error: 'Sharing is not available on this device' };
    }

    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      dialogTitle: 'Save Spreadsheet',
      UTI: 'org.openxmlformats.spreadsheetml.sheet',
    });

    console.log('✅ Excel file shared successfully');
    return { success: true };
  } catch (error: any) {
    console.error('❌ Error creating spreadsheet:', error);
    return { success: false, error: error.message || String(error) };
  }
}
