const express = require('express');
const ccxt = require('ccxt');
const { RSI, EMA } = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());

// Используем Kraken, так как Binance часто блокирует облачные сервера
const exchange = new ccxt.kraken();

let lastData = {
    price: 0,
    rsi: 0,
    ema: 0,
    status: "СИНХРОНИЗАЦИЯ...",
    color: "#6366f1",
    entry: "---",
    tp: "---",
    sl: "---"
};

async function update() {
    try {
        // У Kraken пара BTC/USDT пишется именно так
        const symbol = 'BTC/USDT';
        const ticker = await exchange.fetchTicker(symbol);
        const candles = await exchange.fetchOHLCV(symbol, '1h', 200);

        const closes = candles.map(c => c[4]);
        const currentPrice = ticker.last;

        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const emaValues = EMA.calculate({ values: closes, period: 200 });

        const currentRSI = rsiValues[rsiValues.length - 1];
        const currentEMA = emaValues[emaValues.length - 1];

        lastData.price = currentPrice;
        lastData.rsi = currentRSI.toFixed(2);
        lastData.ema = currentEMA.toFixed(2);

        // Логика сигналов JSculptor
        if (currentPrice > currentEMA && currentRSI < 30) {
            lastData.status = "ПОКУПКА (BUY)";
            lastData.color = "#10b981";
            lastData.entry = currentPrice;
            lastData.tp = (currentPrice * 1.02).toFixed(2);
            lastData.sl = (currentPrice * 0.98).toFixed(2);
        } else if (currentPrice < currentEMA && currentRSI > 70) {
            lastData.status = "ПРОДАЖА (SELL)";
            lastData.color = "#ef4444";
            lastData.entry = currentPrice;
            lastData.tp = (currentPrice * 0.98).toFixed(2);
            lastData.sl = (currentPrice * 1.02).toFixed(2);
        } else {
            lastData.status = "ОЖИДАНИЕ...";
            lastData.color = "#6366f1";
            lastData.entry = "---";
            lastData.tp = "---";
            lastData.sl = "---";
        }

        console.log(`[${new Date().toLocaleTimeString()}] Цена: $${currentPrice} | RSI: ${lastData.rsi}`);

    } catch (e) {
        console.error("Ошибка биржи:", e.message);
    }
}

// Запрос данных раз в 10 секунд
setInterval(update, 10000);
update();

app.get('/api/data', (req, res) => {
    res.json(lastData);
});

// ПОРТ: Render сам назначит его через process.env.PORT
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`=========================================`);
    console.log(`🚀 JSculptor Trading System запущен!`);
    console.log(`📡 Порт: ${port}`);
    console.log(`=========================================`);
});