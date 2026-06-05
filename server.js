const express = require('express');
const cors = require('cors');

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

// Типы продуктов
const PRODUCT_TYPES = {
  'life': 'life',
  'property': 'property',
  'title': 'title',
  'all': null
};

/**
 * Создает расчет на сравни.ру и получает searchId
 */
async function createCalculation(params) {
  const { bank, creditSum, age, gender, productType } = params;
  
  const bankId = BANK_IDS[bank] || 262; // default ВТБ
  const sex = gender === 'женщина' ? 'female' : 'male';
  const birthDate = new Date();
  birthDate.setFullYear(birthDate.getFullYear() - age);
  const birthDateStr = birthDate.toISOString().split('T')[0];
  
  // Определяем тип продукта
  const pType = PRODUCT_TYPES[productType] || null;
  
  const payload = {
    bankId: bankId,
    creditSum: creditSum,
    age: age,
    sex: sex,
    birthDate: birthDateStr,
    productType: pType
  };
  
  // Добавляем риски по типу
  if (pType === 'life') {
    payload.risks = ['life'];
  } else if (pType === 'property') {
    payload.risks = ['property'];
  } else if (pType === 'title') {
    payload.risks = ['title'];
  } else {
    payload.risks = ['life', 'property', 'title'];
  }

  const response = await fetch('https://www.sravni.ru/strahovanie-ipoteki/api/calculations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.sravni.ru',
      'Referer': 'https://www.sravni.ru/strahovanie-ipoteki/kalkuljator/'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Create calculation failed: ${response.status}`);
  }

  const data = await response.json();
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
        'Referer': 'https://www.sravni.ru/strahovanie-ipoteki/kalkuljator/'
      }
    });

    if (!response.ok) {
      throw new Error(`Get results failed: ${response.status}`);
    }

    const data = await response.json();
    
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

  const results = [];
  const seen = new Set();

  for (const item of data.items) {
    const name = item.insuranceCompanyName || item.product?.insuranceCompanyName;
    const price = item.price || item.discountPrice;
    
    if (!name || !price || price <= 0) continue;
    
    const key = name.toLowerCase().replace(/\s/g, '');
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name: name,
      total: Math.round(price)
    });
  }

  // Сортируем по цене
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
