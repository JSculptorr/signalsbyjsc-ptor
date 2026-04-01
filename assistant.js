const ccxt = require('ccxt');
const { RSI, EMA } = require('technicalindicators');
const express = require('express');
const path = require('path');
const app = express();
const exchange = new ccxt.kraken();

// Данные для JSculptor UI с расширенными параметрами сигнала
let marketData = { 
    price: 0, 
    rsi: 0, 
    ema: 0, 
    status: "Синхронизация...", 
    color: "#6366f1",
    entry: "---", 
    tp: "---", 
    sl: "---" 
};

async function update() {
    try {
     // Замени везде 'BTC/USDT' на 'BTC/USDT' или 'BTC/USD'
const ticker = await exchange.fetchTicker('BTC/USDT');
const candles = await exchange.fetchOHLCV('BTC/USDT', '1h', 200);
        const prices = candles.map(c => c[4]);

        marketData.price = ticker.last;
        marketData.rsi = RSI.calculate({ values: prices, period: 14 }).slice(-1)[0] || 0;
        marketData.ema = EMA.calculate({ values: prices, period: 200 }).slice(-1)[0] || 0;

        // ЛОГИКА ТОЧНОГО СИГНАЛА (JSculptor Strategy)
        const isLong = marketData.price > marketData.ema && marketData.rsi < 30;
        const isShort = marketData.price < marketData.ema && marketData.rsi > 70;

        if (isLong) {
            marketData.status = "🟢 СИГНАЛ: BUY (LONG)";
            marketData.color = "#10b981";
            marketData.entry = marketData.price;
            marketData.tp = (marketData.price * 1.015).toFixed(2); // +1.5% прибыль
            marketData.sl = (marketData.price * 0.99).toFixed(2);   // -1% стоп
        } else if (isShort) {
            marketData.status = "🔴 СИГНАЛ: SELL (SHORT)";
            marketData.color = "#ef4444";
            marketData.entry = marketData.price;
            marketData.tp = (marketData.price * 0.985).toFixed(2); // +1.5% прибыль на падении
            marketData.sl = (marketData.price * 1.01).toFixed(2);   // -1% стоп
        } else {
            marketData.status = "⏳ ПОИСК ТОЧКИ ВХОДА...";
            marketData.color = "#6366f1";
            // Не обнуляем последние сигналы, чтобы они висели на экране
        }

        console.log(`[JSculptor] BTC: $${marketData.price} | RSI: ${marketData.rsi.toFixed(2)} | EMA: ${marketData.ema.toFixed(0)}`);
    } catch (e) { 
        console.log("Ошибка биржи:", e.message); 
    }
}

setInterval(update, 5000);

app.get('/api/data', (req, res) => res.json(marketData));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(3000, () => {
    console.log("========================================");
    console.log("🚀 JSculptor Trading System запущен!");
    console.log("🔗 Ссылка: http://localhost:3000");
    console.log("========================================");
    update();
});