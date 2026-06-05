const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

/**
 * API: получить цены со сравни.ру
 * POST /api/sravni
 * Body: { osz: number, age: number, gender?: string, bank?: string }
 */
app.post('/api/sravni', async (req, res) => {
  const { osz, age, gender, bank } = req.body;
  if (!osz || !age) {
    return res.status(400).json({ error: 'Требуются osz и age' });
  }

  const cacheKey = `${osz}_${age}_${gender || 'm'}_${bank || ''}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return res.json({ prices: cached.prices, fromCache: true });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Блокируем лишние ресурсы для ускорения
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // 1. Открываем калькулятор
    await page.goto('https://www.sravni.ru/strahovanie-ipoteki/kalkuljator/', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await page.waitForTimeout(3000);

    // 2. Заполняем сумму кредита
    const filledSum = await tryFillField(page, [
      'input[name="creditSum"]',
      'input[placeholder*="сумм" i]',
      'input[placeholder*="Сумм" i]',
      '[data-testid*="sum"] input',
      'input[type="text"]'
    ], String(osz));

    if (!filledSum) {
      console.warn('Не удалось найти поле суммы, пробуем через evaluate');
      await page.evaluate((val) => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
        for (const inp of inputs) {
          if (inp.placeholder && /сумм/i.test(inp.placeholder)) {
            inp.value = val;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }, String(osz));
    }

    await page.waitForTimeout(1500);

    // 3. Заполняем возраст
    const filledAge = await tryFillField(page, [
      'input[name="age"]',
      'input[placeholder*="возраст" i]',
      'input[placeholder*="Возраст" i]',
      '[data-testid*="age"] input',
      'input[type="number"]'
    ], String(age));

    if (!filledAge) {
      await page.evaluate((val) => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
        for (const inp of inputs) {
          if (inp.placeholder && /возраст/i.test(inp.placeholder)) {
            inp.value = val;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }, String(age));
    }

    await page.waitForTimeout(1500);

    // 4. Кликаем "Рассчитать"
    const clicked = await tryClickButton(page, [
      'button[type="submit"]',
      'button:has-text("Рассчитать")',
      'button:has-text("Показать")',
      '[data-testid*="submit"]',
      'button[class*="submit"]'
    ]);

    if (!clicked) {
      // Fallback: ищем любую кнопку с текстом "асчит" или "оказать"
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.innerText || btn.textContent || '';
          if (/асчит|оказать/i.test(text)) {
            btn.click();
            break;
          }
        }
      });
    }

    // 5. Ждем загрузки результатов (увеличено для медленного free tier)
    await page.waitForTimeout(12000);

    // 6. Парсим цены
    const prices = await page.evaluate(() => {
      const results = [];
      const known = [
        'Ингосстрах','СберСтрахование','Сбер Страхование',
        'РЕСО','РЕСО-Гарантия',
        'АльфаСтрахование','Альфа Страхование',
        'ВСК','Согаз','СОГАЗ',
        'Росгосстрах','Росгосстрах',
        'Тинькофф','Тинькофф Страхование',
        'Гелиос','МАКС','Эрго',
        'ТК Страхование','Югория'
      ];

      // Стратегия 1: ищем в карточках
      const containers = document.querySelectorAll('div, article, section, li');
      for (const card of containers) {
        const text = card.innerText || '';
        for (const name of known) {
          if (text.includes(name)) {
            // Ищем цену внутри этого контейнера или ближайших соседей
            const priceMatch = text.match(/(\d[\s\d]*\d)\s*₽/);
            if (priceMatch) {
              const price = parseInt(priceMatch[1].replace(/\s/g, ''), 10);
              if (price > 1000 && !results.some(r => r.name === name)) {
                results.push({ name, total: price });
                break;
              }
            }
          }
        }
      }

      // Стратегия 2: если ничего не нашли, ищем по всему тексту
      if (results.length === 0) {
        const bodyText = document.body.innerText;
        const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          for (const name of known) {
            if (line.includes(name)) {
              const pm = line.match(/(\d[\s\d]*\d)\s*₽/);
              if (pm) {
                const price = parseInt(pm[1].replace(/\s/g, ''), 10);
                if (price > 1000 && !results.some(r => r.name === name)) {
                  results.push({ name, total: price });
                }
              }
            }
          }
        }
      }

      // Удаляем дубликаты, оставляя минимальную цену
      const byName = {};
      for (const r of results) {
        const key = r.name.toLowerCase().replace(/\s/g, '');
        if (!byName[key] || r.total < byName[key].total) {
          byName[key] = r;
        }
      }
      return Object.values(byName);
    });

    cache.set(cacheKey, { prices, ts: Date.now() });
    res.json({ prices, fromCache: false, parsedAt: new Date().toISOString() });

  } catch (err) {
    console.error('Puppeteer error:', err);
    res.status(500).json({ error: err.message, prices: [] });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * Пытается заполнить поле по одному из селекторов
 */
async function tryFillField(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(value);
        return true;
      }
    } catch (e) {
      // игнорируем
    }
  }
  return false;
}

/**
 * Пытается кликнуть кнопку по одному из селекторов
 */
async function tryClickButton(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch (e) {
      // игнорируем
    }
  }
  return false;
}

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
