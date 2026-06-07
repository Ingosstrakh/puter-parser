const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { fillFormAutomatically } = require('./form-automation');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Раздача статических файлов (index.html)

const PORT = process.env.PORT || 3001;
const AUTH_PASSWORD = '2026';

// Middleware для проверки авторизации
function requireAuth(req, res, next) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  
  const token = req.headers.authorization.replace('Bearer ', '');
  if (token !== AUTH_PASSWORD) {
    return res.status(403).json({ error: 'Неверный пароль' });
  }
  
  next();
}

/**
 * Полностью автоматический подход: Playwright открывает страницу, заполняет форму автоматически,
 * внедряет Console Snippet, перехватывает API, возвращает результат
 */
async function fetchPricesAutomated(params) {
  console.log('[Server] Запуск автоматического заполнения формы');
  console.log('[Server] Параметры:', params);

  // Headless mode для Railway (true на сервере, false для локальной разработки)
  const isHeadless = process.env.RAILWAY_ENVIRONMENT === 'production' || process.env.HEADLESS === 'true';
  const browserlessUrl = process.env.BROWSERLESS_URL;
  
  let browser;
  
  if (browserlessUrl) {
    // Используем удалённый браузер (browserless.io)
    console.log('[Server] Подключение к удалённому браузеру...');
    browser = await chromium.connectOverCDP(browserlessUrl);
  } else {
    // Локальный запуск - используем встроенный Chromium
    console.log('[Server] Запуск локального Chromium...');
    browser = await chromium.launch({
      headless: isHeadless,
      args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
    });
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('[Server] Открываем sravni.ru...');
    await page.goto('https://www.sravni.ru/strahovanie-ipoteki/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Внедряем Console Snippet ПЕРЕД заполнением формы
    console.log('[Server] Внедряю Console Snippet...');
    const snippetCode = `
      (function() {
        'use strict';
        console.log('[Сниппет] Console Snippet внедрен');
        
        let apiData = null;
        let saveTimeout = null;
        
        // Перехват XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        
        XMLHttpRequest.prototype.open = function(method, url) {
          this._url = url;
          console.log('[Сниппет] XHR open:', method, url);
          return origOpen.apply(this, arguments);
        };
        
        XMLHttpRequest.prototype.send = function() {
          console.log('[Сниппет] XHR send:', this._url);
          
          this.addEventListener('load', function() {
            console.log('[Сниппет] XHR response status:', this.status, 'для URL:', this._url);
            
            if (this._url && this._url.includes('/api/calculations/')) {
              try {
                const json = JSON.parse(this.responseText);
                console.log('[Сниппет] JSON получен, items:', json.items?.length || 0);
                
                // Проверяем что есть реальные цены (>0)
                const hasRealPrices = json.items && json.items.some(item => {
                  const price = item.price || item.discountPrice;
                  return price > 0;
                });
                
                if (json && json.items && json.items.length > 0 && hasRealPrices) {
                  // Debounce: ждем 5 секунд после последнего XHR с реальными ценами
                  console.log('[Сниппет] Получены реальные цены, жду 5 секунд для подтверждения...');
                  
                  if (saveTimeout) {
                    clearTimeout(saveTimeout);
                  }
                  
                  saveTimeout = setTimeout(() => {
                    apiData = json;
                    console.log('[Сниппет] API перехвачен с реальными ценами! Найдено items:', json.items.length);
                    
                    // Сохраняем в глобальную переменную для Playwright
                    window.__INGOS_SRAVNI_DATA = apiData;
                    console.log('[Сниппет] Данные сохранены в window.__INGOS_SRAVNI_DATA');
                  }, 5000);
                } else {
                  console.log('[Сниппет] JSON получен но нет реальных цен (все price=0), жду настоящий запрос...');
                }
              } catch (e) {
                console.log('[Сниппет] Ошибка парсинга JSON:', e);
              }
            }
          });
          
          return origSend.apply(this, arguments);
        };
        
        console.log('[Сниппет] Ожидание заполнения формы и нажатия "Рассчитать"...');
      })();
    `;

    await page.evaluate(snippetCode);
    console.log('[Server] Console Snippet внедрен');

    // Автоматическое заполнение формы
    console.log('[Server] Автоматическое заполнение формы...');
    await fillFormAutomatically(page, params);
    console.log('[Server] Форма заполнена, кнопка нажата');

    // Ждем данные от Console Snippet
    console.log('[Server] Ожидание данных от API (максимум 30 секунд)...');

    let checks = 0;
    while (checks < 30) { // 30 секунд
      await page.waitForTimeout(1000);
      
      // Проверяем есть ли данные в глобальной переменной
      const hasData = await page.evaluate(() => {
        return window.__INGOS_SRAVNI_DATA !== undefined;
      });
      
      if (hasData) {
        console.log('[Server] Данные получены!');
        break;
      }
      
      checks++;
      if (checks % 5 === 0) {
        console.log(`[Server] Прошло ${checks} секунд, жду данные...`);
      }
    }

    // Считываем данные
    const apiData = await page.evaluate(() => {
      return window.__INGOS_SRAVNI_DATA;
    });

    if (!apiData) {
      throw new Error('Не удалось получить данные за 30 секунд. Возможно, автоматическое заполнение формы не сработало.');
    }

    console.log('[Server] Получены данные:', apiData.items?.length || 0, 'предложений');

    // Парсинг цен с фильтрацией по рискам
    console.log('[Server] Начинаю парсинг цен из items...');
    
    // Парсим риски из параметров
    const requestedRisks = (params.risks || '').split(',').map(r => r.trim().toLowerCase());
    
    const byCompany = {};
    for (const item of apiData.items || []) {
      const name = item.insuranceCompanyName;
      const price = item.price || item.discountPrice;
      const productTypes = item.product?.types || [];
      
      if (!name || !price || price <= 0) continue;
      
      // Фильтруем по типам рисков
      let matches = false;
      
      if (requestedRisks.length === 0) {
        matches = true;
      } else {
        const hasAllRequested = requestedRisks.every(risk => {
          const riskMap = { 'life': 'life', 'property': 'property', 'title': 'title' };
          return productTypes.includes(riskMap[risk] || risk);
        });
        
        const hasNoExtra = productTypes.every(type => {
          const reverseMap = { 'life': 'life', 'property': 'property', 'title': 'title' };
          return requestedRisks.includes(reverseMap[type] || type);
        });
        
        matches = hasAllRequested && hasNoExtra;
      }
      
      if (matches) {
        byCompany[name] = (byCompany[name] || 0) + price;
      }
    }

    const prices = Object.entries(byCompany)
      .map(([name, total]) => ({ name, total: Math.round(total) }))
      .sort((a, b) => a.total - b.total);

    console.log('[Server] Найдено предложений:', prices.length);

    // Формируем рекомендацию
    const recommendation = generateRecommendation(params.ingosPrice, prices);

    return {
      success: true,
      prices: prices,
      recommendation: recommendation
    };

  } catch (error) {
    console.error('[Server] Ошибка:', error.message);
    return {
      success: false,
      error: error.message
    };
  } finally {
    await browser.close();
  }
}

/**
 * Генерирует рекомендацию по скидке
 */
function generateRecommendation(ingosPrice, competitorPrices) {
  if (!ingosPrice || competitorPrices.length === 0) {
    return null;
  }

  // Ищем самого дешевого конкурента
  let cheapest = null;
  let cheapestDiff = Infinity;
  
  for (const competitor of competitorPrices) {
    const diff = ingosPrice - competitor.total;
    if (diff > 0 && diff < cheapestDiff) {
      cheapestDiff = diff;
      cheapest = competitor;
    }
  }

  if (!cheapest) {
    return {
      message: 'Ингосстрах уже предлагает самую низкую цену на рынке',
      discountPercent: 0,
      discountAmount: 0
    };
  }

  const discountPercent = Math.min(50, Math.round((cheapestDiff / ingosPrice) * 100));
  
  return {
    message: `Чтобы догнать "${cheapest.name}", увеличьте скидку на ~${discountPercent}% или снизьте премию на ${cheapestDiff.toLocaleString('ru-RU')} ₽`,
    discountPercent: discountPercent,
    discountAmount: cheapestDiff,
    competitor: cheapest.name,
    competitorPrice: cheapest.total
  };
}

// API endpoint - требует авторизации
app.post('/api/fetch-prices', requireAuth, async (req, res) => {
  const params = req.body;
  
  // Основные обязательные параметры
  if (!params.bank || !params.amount || !params.risks) {
    return res.status(400).json({ error: 'Missing required parameters: bank, amount, risks' });
  }

  // Для property-only gender не обязателен (используется дефолт)
  const isPropertyOnly = params.risks === 'property' || (params.risks?.includes && params.risks.includes('property') && !params.risks.includes('life'));
  
  if (!isPropertyOnly && !params.gender) {
    return res.status(400).json({ error: 'Missing required parameter: gender (or use sex)' });
  }

  try {
    const result = await fetchPricesAutomated(params);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Запуск сервера
// HTML страница с кнопкой авторизации
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Sravni Parser Auth</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 30px; }
    .btn { background: #4CAF50; color: white; border: none; padding: 15px 40px; font-size: 18px; border-radius: 5px; cursor: pointer; margin: 10px; }
    .btn:hover { background: #45a049; }
    .btn:disabled { background: #ccc; cursor: not-allowed; }
    #passwordForm { display: none; margin-top: 20px; }
    input[type="password"] { padding: 10px; font-size: 16px; border: 1px solid #ddd; border-radius: 5px; width: 200px; }
    .error { color: red; margin-top: 10px; }
    .success { color: green; margin-top: 10px; }
    #apiSection { display: none; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
    textarea { width: 100%; min-width: 400px; height: 150px; margin: 10px 0; font-family: monospace; font-size: 12px; }
    pre { background: #f5f5f5; padding: 10px; border-radius: 5px; text-align: left; overflow-x: auto; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sravni.ru Parser</h1>
    
    <button id="sravniBtn" class="btn">Sravni Ru</button>
    
    <div id="passwordForm">
      <p>Введите пароль:</p>
      <input type="password" id="password" placeholder="Пароль">
      <button id="loginBtn" class="btn">Войти</button>
      <div id="error" class="error"></div>
    </div>
    
    <div id="apiSection">
      <div class="success">Авторизация успешна!</div>
      <h3>Тест API</h3>
      <textarea id="jsonInput" placeholder='{
  "bank": "ВТБ",
  "amount": 1000000,
  "age": 30,
  "gender": "муж",
  "risks": "life,property"
}'></textarea>
      <br>
      <button id="testBtn" class="btn">Получить цены</button>
      <pre id="result"></pre>
    </div>
  </div>
  
  <script>
    let token = localStorage.getItem('sravni_token');
    
    if (token) {
      document.getElementById('sravniBtn').style.display = 'none';
      document.getElementById('passwordForm').style.display = 'none';
      document.getElementById('apiSection').style.display = 'block';
    }
    
    document.getElementById('sravniBtn').onclick = function() {
      this.disabled = true;
      document.getElementById('passwordForm').style.display = 'block';
      document.getElementById('password').focus();
    };
    
    document.getElementById('loginBtn').onclick = async function() {
      const password = document.getElementById('password').value;
      const errorDiv = document.getElementById('error');
      
      if (password === '2026') {
        localStorage.setItem('sravni_token', '2026');
        document.getElementById('passwordForm').style.display = 'none';
        document.getElementById('apiSection').style.display = 'block';
        errorDiv.textContent = '';
      } else {
        errorDiv.textContent = 'Неверный пароль';
      }
    };
    
    document.getElementById('testBtn').onclick = async function() {
      const resultDiv = document.getElementById('result');
      resultDiv.textContent = 'Загрузка...';
      
      try {
        const params = JSON.parse(document.getElementById('jsonInput').value);
        const response = await fetch('/api/fetch-prices', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer 2026'
          },
          body: JSON.stringify(params)
        });
        
        const data = await response.json();
        resultDiv.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        resultDiv.textContent = 'Ошибка: ' + e.message;
      }
    };
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`[Server] Автоматический сервер запущен на порту ${PORT}`);
  console.log(`[Server] API endpoint: http://localhost:${PORT}/api/fetch-prices`);
});
