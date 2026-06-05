# ingos-sravni-parser

Сервер для парсинга цен ипотечного страхования со [сравни.ру](https://www.sravni.ru/strahovanie-ipoteki/kalkuljator/).

## Архитектура

```
Ваш калькулятор (GitHub Pages)
    ↓ POST /api/sravni
ingos-sravni-parser (Render.com)
    → Puppeteer открывает сравни.ру
    → Заполняет форму
    → Парсит цены СК
    ↓ JSON
Калькулятор показывает сравнение + рекомендацию
```

## Деплой на Render.com

1. Запушьте этот репозиторий на GitHub
2. Зарегистрируйтесь на [render.com](https://render.com)
3. **New → Web Service → Build and deploy from a Git repository**
4. Выберите репозиторий `ingos-sravni-parser`
5. Настройки:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
6. **Create Web Service**

После деплоя получите URL вида: `https://ingos-sravni-parser-xxx.onrender.com`

## API

### POST /api/sravni

Получить цены со сравни.ру.

**Request:**
```json
{
  "osz": 6000000,
  "age": 50,
  "gender": "женщина",
  "bank": "ВТБ"
}
```

**Response:**
```json
{
  "prices": [
    { "name": "СберСтрахование", "total": 18500 },
    { "name": "Тинькофф Страхование", "total": 17200 },
    { "name": "Росгосстрах", "total": 19800 }
  ],
  "fromCache": false
}
```

## Подключение к калькулятору

В файле `competitors.js` вашего основного калькулятора замените:

```javascript
const SERVER_URL = 'https://ingos-sravni-parser-xxx.onrender.com';
```

## Ограничения бесплатного тарифа Render

- Сервер "засыпает" после 15 мин бездействия. Первый запрос после сна занимает ~30 сек.
- Puppeteer тяжелый, запрос занимает 8-15 секунд.
- Если сравни.ру покажет CAPTCHA — парсинг может не сработать.

## Локальный запуск (для теста)

```bash
npm install
npm start
```

Сервер поднимется на `http://localhost:3000`
