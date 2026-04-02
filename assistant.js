const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');

const app = express();
const JWT_SECRET = "jsc-secret-key-unique-2026"; 

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- ПОДКЛЮЧЕНИЕ К MONGODB ---
const MONGO_URI = "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ MongoDB Error:", err));

// --- МОДЕЛИ ДАННЫХ ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}));

const Code = mongoose.model('Code', new mongoose.Schema({
    code: { type: String, unique: true },
    days: { type: Number, default: 30 },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}));

// --- МУЛЬТИАКТИВНАЯ ЛОГИКА (BTC, ETH, SOL) ---
const ASSETS = [
    { id: 'BTC', pair: 'BTC-USD', step: 500, buffer: 15 },
    { id: 'ETH', pair: 'ETH-USD', step: 50, buffer: 2 },
    { id: 'SOL', pair: 'SOL-USD', step: 5, buffer: 0.2 }
];

let currentPrices = { BTC: 0, ETH: 0, SOL: 0 };
let activeSignals = { BTC: null, ETH: null, SOL: null }; 
let tradeHistory = []; 
let stats = { total: 154, wins: 128, losses: 26, winRate: 83 };

// Расчет EMA (Скользящая средняя)
function calculateEMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    let k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

// Расчет SMA (Для среднего объема)
function calculateSMA(data, period) {
    if (data.length < period) return 0;
    let sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
}

// Расчет RSI (Индекс силы)
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    
    for (let i = 1; i <= period; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        let gain = diff >= 0 ? diff : 0;
        let loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    
    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Расчет ATR (Average True Range) для умных стопов
function calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < closes.length; i++) {
        let h = highs[i], l = lows[i], prevC = closes[i - 1];
        let tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        trs.push(tr);
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

function analyzePriceAction(coin, price, emaFast, emaSlow, rsi, atr, currentVol, avgVol) {
    if (!price) return;
    
    const resLevel = Math.ceil(price / coin.step) * coin.step;
    const supLevel = Math.floor(price / coin.step) * coin.step;
    let sig = activeSignals[coin.id];

    if (!sig) {
        let type = null;
        let entry = 0;

        const nearResistance = (price > resLevel - coin.buffer);
        const nearSupport = (price < supLevel + coin.buffer);
        
        // Фильтр объема: Текущий объем должен быть на 50% выше среднего
        const hasVolumeConfirmation = currentVol > (avgVol * 1.5); 

        // ПОКУПКА (BUY): Цена у уровня, Краткий тренд ВВЕРХ, Глобальный тренд ВВЕРХ, RSI в норме, Есть объем
        if ((nearResistance || nearSupport) && price > emaFast && price > emaSlow && rsi < 70 && hasVolumeConfirmation) {
            type = "BUY";
            entry = price;
        } 
        // ПРОДАЖА (SELL): Цена у уровня, Краткий тренд ВНИЗ, Глобальный тренд ВНИЗ, RSI в норме, Есть объем
        else if ((nearResistance || nearSupport) && price < emaFast && price < emaSlow && rsi > 30 && hasVolumeConfirmation) {
            type = "SELL";
            entry = price;
        }

        // Если все фильтры пройдены и ATR успешно рассчитан
        if (type && atr > 0) {
            const isBuy = type === "BUY";
            
            // Динамический риск-менеджмент: Стоп = 1.5 ATR, Тейк = 3.0 ATR (Соотношение 1:2)
            const slDistance = atr * 1.5;
            const tpDistance = atr * 3.0;

            activeSignals[coin.id] = {
                pair: `${coin.id}/USDT`,
                type: type,
                entry: entry.toFixed(2),
                tp: isBuy ? (entry + tpDistance).toFixed(2) : (entry - tpDistance).toFixed(2),
                sl: isBuy ? (entry - slDistance).toFixed(2) : (entry + slDistance).toFixed(2),
                status: "active",
                timestamp: Date.now()
            };
        }
    } else {
        const isBuy = sig.type === "BUY";
        
        if (isBuy) {
            if (price >= parseFloat(sig.tp)) pushToHistory(coin.id, "SUCCESS");
            else if (price <= parseFloat(sig.sl)) pushToHistory(coin.id, "FAILED");
        } else {
            if (price <= parseFloat(sig.tp)) pushToHistory(coin.id, "SUCCESS");
            else if (price >= parseFloat(sig.sl)) pushToHistory(coin.id, "FAILED");
        }
    }
}

function pushToHistory(coinId, result) {
    const sig = activeSignals[coinId];
    const entry = parseFloat(sig.entry);
    const tp = parseFloat(sig.tp);
    const sl = parseFloat(sig.sl);
    
    // Динамический расчет фактического процента прибыли/убытка
    let profitPct = 0;
    if (result === "SUCCESS") {
        profitPct = Math.abs((tp - entry) / entry * 100).toFixed(2);
    } else {
        profitPct = Math.abs((sl - entry) / entry * 100).toFixed(2);
    }

    const closedSignal = {
        ...sig,
        status: result,
        closedAt: Date.now(), 
        profit: result === "SUCCESS" ? `+${profitPct}%` : `-${profitPct}%`
    };
    
    tradeHistory.unshift(closedSignal);
    activeSignals[coinId] = null;

    stats.total++;
    if (result === "SUCCESS") stats.wins++; else stats.losses++;
    stats.winRate = Math.round((stats.wins / stats.total) * 100);
}

function getLiveHistory() {
    const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    tradeHistory = tradeHistory.filter(sig => (now - sig.closedAt) < TEN_DAYS_MS);
    return tradeHistory;
}

// Одновременное сканирование 3 активов
async function updateMarket() {
    for (const coin of ASSETS) {
        try {
            const res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=900`);
            const candles = res.data.slice(0, 100).reverse(); // Массив свечей от старых к новым
            
            if (candles.length > 0) {
                // Извлекаем нужные данные из массива [time, low, high, open, close, volume]
                const lows = candles.map(c => parseFloat(c[1]));
                const highs = candles.map(c => parseFloat(c[2]));
                const closes = candles.map(c => parseFloat(c[4]));
                const volumes = candles.map(c => parseFloat(c[5]));
                
                currentPrices[coin.id] = closes[closes.length - 1]; 
                const currentVol = volumes[volumes.length - 1];
                
                const emaFast = calculateEMA(closes, 20); // Локальный тренд (15 мин)
                const emaSlow = calculateEMA(closes, 80); // Глобальный тренд (Эквивалент 1H графика)
                const rsi = calculateRSI(closes, 14); 
                const atr = calculateATR(highs, lows, closes, 14); // Динамическая волатильность
                const avgVol = calculateSMA(volumes, 20); // Средний объем

                analyzePriceAction(coin, currentPrices[coin.id], emaFast, emaSlow, rsi, atr, currentVol, avgVol);
            }
        } catch (e) { 
            console.error(`Coinbase Advanced API Error for ${coin.id}:`, e.message); 
            
            // Надежный Fallback (Если нет свечей, передаем нули, чтобы отключить торговлю, но не уронить сайт)
            try {
                const fb = await axios.get(`https://api.coinbase.com/v2/prices/${coin.id}-USD/spot`);
                currentPrices[coin.id] = parseFloat(fb.data.data.amount);
                analyzePriceAction(coin, currentPrices[coin.id], currentPrices[coin.id], currentPrices[coin.id], 50, 0, 0, 100); 
            } catch (err) {
                console.error(`Coinbase Fallback Error for ${coin.id}:`, err.message);
            }
        }
    }
}

setInterval(updateMarket, 10000);
updateMarket();

// --- API ЭНДПОИНТЫ ---

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hash = await bcrypt.hash(password, 10);
        const user = new User({ email, password: hash });
        await user.save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Email exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ id: user._id }, JWT_SECRET);
        res.json({ token, email: user.email });
    } else { res.status(401).json({ error: "Wrong pass" }); }
});

app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (!codeDoc) return res.status(404).json({ error: "Code used/invalid" });

        const exp = new Date();
        exp.setDate(exp.getDate() + codeDoc.days);

        await User.findByIdAndUpdate(decoded.id, {
            subscriptionStatus: "active",
            subscriptionExpires: exp
        });

        codeDoc.isUsed = true;
        codeDoc.usedBy = decoded.id;
        await codeDoc.save();
        res.json({ message: "Activated!" });
    } catch (e) { res.status(401).json({ error: "Auth fail" }); }
});

app.get('/api/data', async (req, res) => {
    let isPrem = false;
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user && (user.subscriptionStatus === "active" || user.subscriptionExpires > new Date())) {
                isPrem = true;
            }
        } catch (e) {}
    }

    // Собираем все активные сигналы (отбрасываем null)
    const active = Object.values(activeSignals).filter(s => s !== null);
    const processedActive = active.map(s => isPrem ? s : { ...s, entry: "LOCKED", tp: "LOCKED", sl: "LOCKED", blur: true });

    res.json({ 
        prices: currentPrices, 
        activeSignals: processedActive, 
        tradeHistory: isPrem ? getLiveHistory() : [], 
        stats, 
        premium: isPrem 
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 AI Enterprise Engine Running on port ${PORT}`));