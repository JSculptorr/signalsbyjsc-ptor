const express = require('express');
const ccxt = require('ccxt');
const { RSI, EMA } = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());

const exchange = new ccxt.coinbase();

// Хранилища данных
let signals = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0 };
let lastPrice = 0;

async function updateLogic() {
    try {
        const symbol = 'BTC/USDT';
        const ticker = await exchange.fetchTicker(symbol);
        const candles = await exchange.fetchOHLCV(symbol, '1h', 200);
        
        lastPrice = ticker.last;
        const closes = candles.map(c => c[4]);

        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const emaValues = EMA.calculate({ values: closes, period: 200 });

        const currentRSI = rsiValues[rsiValues.length - 1];
        const currentEMA = emaValues[emaValues.length - 1];

        // 1. ПРОВЕРКА СУЩЕСТВУЮЩИХ СИГНАЛОВ (WIN/LOSS/EXPIRED)
        const now = new Date();
        signals.forEach(sig => {
            if (sig.status === "active") {
                // Проверка Win
                if ((sig.type === "BUY" && lastPrice >= sig.tp) || (sig.type === "SELL" && lastPrice <= sig.tp)) {
                    sig.status = "win";
                    sig.closed_at = now.toLocaleTimeString();
                } 
                // Проверка Loss
                else if ((sig.type === "BUY" && lastPrice <= sig.sl) || (sig.type === "SELL" && lastPrice >= sig.sl)) {
                    sig.status = "loss";
                    sig.closed_at = now.toLocaleTimeString();
                }
                // Проверка на 2 часа (120 минут)
                const age = (now - new Date(sig.timestamp)) / 1000 / 60;
                if (age > 120) {
                    sig.status = "expired";
                }
            }
        });

        // Обновляем статистику
        const closed = signals.filter(s => s.status === "win" || s.status === "loss");
        stats.total = closed.length;
        stats.wins = closed.filter(s => s.status === "win").length;
        stats.losses = closed.filter(s => s.status === "loss").length;
        stats.winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : 0;

        // 2. ГЕНЕРАЦИЯ НОВОГО СИГНАЛА (если условий нет в активных)
        const activeNow = signals.find(s => s.status === "active");
        if (!activeNow) {
            let type = "";
            if (lastPrice > currentEMA && currentRSI < 30) type = "BUY";
            if (lastPrice < currentEMA && currentRSI > 70) type = "SELL";

            if (type !== "") {
                const newSig = {
                    id: Date.now(),
                    pair: "BTC/USDT",
                    type: type,
                    entry: lastPrice,
                    tp: type === "BUY" ? (lastPrice * 1.01).toFixed(2) : (lastPrice * 0.99).toFixed(2),
                    sl: type === "BUY" ? (lastPrice * 0.99).toFixed(2) : (lastPrice * 1.01).toFixed(2),
                    status: "active",
                    timestamp: now,
                    created_at: now.toLocaleTimeString()
                };
                signals.push(newSig);
            }
        }

        console.log(`[JSculptor] Price: ${lastPrice} | Active Signals: ${signals.filter(s=>s.status==='active').length}`);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

// Цикл обновления 30 секунд
setInterval(updateLogic, 30000);
updateLogic();

app.get('/api/data', (req, res) => {
    res.json({ price: lastPrice, signals, stats });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend live on ${port}`));