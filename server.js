const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

// ID банков на сравни.ру
const BANK_IDS = {
  'ВТБ': 262,
  'Сбербанк': 147,
  'Сбер': 147,
  'Дом.РФ': 284,
  'ДомРФ': 284,
  'Альфа': 3,
  'Альфа-Банк': 3,
  'Тинькофф': 6,
  'МТС': 423,
  'Газпромбанк': 96,
  'Открытие': 231,
  'ПСБ': 193,
  'Райффайзен': 1,
  'Совкомбанк': 192,
  'Уралсиб': 88,
  'ЮниКредит': 228
};

// productTypes для сравни.ру
const PRODUCT_TYPE_MAP = {
  'life': ['life'],
  'property': ['property'],
  'title': ['title'],
  'all': []
};

function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : 
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = crypto.randomBytes(1)[0] % 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
}

/**
 * Создает расчет на сравни.ру и получает searchId
 */
async function createCalculation(params) {
  const { bank, creditSum, age, gender, productType, loanDate } = params;
  
  const creditBankId = BANK_IDS[bank] || 262;
  const borrowerSex = gender === 'женщина' ? 'female' : 'male';
  
  // birthDate: age лет назад
  const now = new Date();
  const birth = new Date(now.getFullYear() - age, now.getMonth(), now.getDate());
  const borrowBirthDate = birth.toISOString();
  
  // loanAgreementDate: текущая дата или переданная
  const loanAgreementDate = loanDate ? new Date(loanDate).toISOString() : now.toISOString();
  
  const pTypes = PRODUCT_TYPE_MAP[productType] || [];
  
  const payload = {
    isBackgroundCalculation: false,
    productTypes: pTypes,
    creditBankId: creditBankId,
    balanceOwed: creditSum,
    borrowBirthDate: borrowBirthDate,
    borrowerSex: borrowerSex,
    deviceId: generateUUID(),
    phone: '79178508969',
    userId: 43782877,
    uaClientId: '653276674.1777712485',
    loanAgreementDate: loanAgreementDate,
    hasOwnerShip: true,
    abCookie: 'ead5b265-b40d-4916.1|833c0117-dcea-467d.0|e562f136-9ae6-4b2f.0|235c890a-f764-491a.1|14482883-88d6-4191.3|8a2b442a-f52a-4e9c.1|fb8da333-9867-4acc.3|706388e1-c0a3-4113.1|c81f3def-aee4-44fb.1|a9063fa5-fd0d-43e8.0|e9349840-37cb-4edd.1|4719fad3-65a0-42a7.0|b784653b-be81-414c.1|1ef0f5fd-3d9b-422e.1|5a80c7e8-a45c-4d7a.0',
    aspxAnonymousCookie: 'k1xKJT1p8k2CuoqX-pdeHg',
    autonomousSystemNumber: '',
    extraInfo: '{"yaClientId":"1743853876675120657"}',
    habitationType: 'house',
    hasGas: false,
    overlapMaterial: 'other',
    partner: {},
    promoCode: null,
    promotion: {},
    utm: {
      medium: 'organic',
      source: 'google',
      campaign: '(not set)',
      content: '(not set)',
      term: '(not set)'
    },
    wallMaterial: 'rock',
    ymClientId: '1743853876675120657'
  };

  console.log('[Sravni] POST payload:', JSON.stringify(payload));

  const response = await fetch('https://www.sravni.ru/strahovanie-ipoteki/api/calculations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.sravni.ru',
      'Referer': 'https://www.sravni.ru/strahovanie-ipoteki/kalkuljator/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();
  console.log('[Sravni] POST response status:', response.status);
  console.log('[Sravni] POST response body:', responseText.substring(0, 500));

  if (!response.ok) {
    throw new Error(`Create calculation failed: ${response.status} — ${responseText.substring(0, 200)}`);
  }

  const data = JSON.parse(responseText);
  return data.searchId;
}

/**
 * Получает результаты расчета
 */
async function getCalculationResults(searchId) {
  const maxAttempts = 10;
  const delayMs = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`https://www.sravni.ru/strahovanie-ipoteki/api/calculations/${searchId}`, {
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.sravni.ru',
        'Referer': 'https://www.sravni.ru/strahovanie-ipoteki/kalkuljator/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': 'abCookie=ead5b265-b40d-4916.1|833c0117-dcea-467d.0|e562f136-9ae6-4b2f.0|235c890a-f764-491a.1|14482883-88d6-4191.3|8a2b442a-f52a-4e9c.1|fb8da333-9867-4acc.3|706388e1-c0a3-4113.1|c81f3def-aee4-44fb.1|a9063fa5-fd0d-43e8.0|e9349840-37cb-4edd.1|4719fad3-65a0-42a7.0|b784653b-be81-414c.1|1ef0f5fd-3d9b-422e.1|5a80c7e8-a45c-4d7a.0; aspxAnonymousCookie=k1xKJT1p8k2CuoqX-pdeHg'
      }
    });

    const responseText = await response.text();
    console.log(`[Sravni] GET attempt ${i+1} status:`, response.status);
    console.log(`[Sravni] GET response body:`, responseText.substring(0, 500));

    if (!response.ok) {
      throw new Error(`Get results failed: ${response.status} — ${responseText.substring(0, 200)}`);
    }

    const data = JSON.parse(responseText);
    
    if (data.isCompleted) {
      return data;
    }

    // Ждем перед следующей попыткой
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error('Calculation timeout');
}

/**
 * Парсит цены из ответа сравни.ру
 */
function parsePrices(data) {
  if (!data || !data.items || !Array.isArray(data.items)) {
    return [];
  }

  const byCompany = {};

  for (const item of data.items) {
    const name = item.insuranceCompanyName;
    const price = item.price || item.discountPrice;
    
    if (!name || !price || price <= 0) continue;
    
    if (!byCompany[name]) {
      byCompany[name] = 0;
    }
    byCompany[name] += price;
  }

  const results = Object.entries(byCompany).map(([name, total]) => ({
    name,
    total: Math.round(total)
  }));

  results.sort((a, b) => a.total - b.total);
  return results;
}

/**
 * API: получить цены со сравни.ру
 * POST /api/sravni
 * Body: { osz: number, age: number, gender?: string, bank?: string, productType?: string }
 */
app.post('/api/sravni', async (req, res) => {
  const { osz, age, gender, bank, productType } = req.body;
  if (!osz || !age) {
    return res.status(400).json({ error: 'Требуются osz и age' });
  }

  const cacheKey = `${osz}_${age}_${gender || 'm'}_${bank || ''}_${productType || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return res.json({ prices: cached.prices, fromCache: true });
  }

  try {
    // 1. Создаем расчет
    const searchId = await createCalculation({
      bank: bank || 'ВТБ',
      creditSum: osz,
      age: age,
      gender: gender || 'мужчина',
      productType: productType || 'all'
    });

    // 2. Получаем результаты
    const results = await getCalculationResults(searchId);

    // 3. Парсим цены
    const prices = parsePrices(results);

    cache.set(cacheKey, { prices, ts: Date.now() });
    res.json({ prices, fromCache: false, searchId, parsedAt: new Date().toISOString() });

  } catch (err) {
    console.error('Sravni API error:', err);
    res.status(500).json({ error: err.message, prices: [] });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ingos-sravni-parser',
    version: '1.0.0',
    endpoints: {
      'POST /api/sravni': 'Получить цены. Body: { osz, age, gender?, bank? }'
    }
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
