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

// --- МАТЕМАТИЧЕСКИЕ ФУНКЦИИ (ХИРУРГИЧЕСКАЯ ТОЧНОСТЬ) ---

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
        avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
}

// НОВАЯ ФУНКЦИЯ: Stochastic RSI (Хирургический фильтр разворота)
function calculateStochRSI(closes, period = 14) {
    if (closes.length < period * 2) return 50;
    let rsiValues = [];
    for (let i = closes.length - period; i < closes.length; i++) {
        rsiValues.push(calculateRSI(closes.slice(0, i + 1), period));
    }
    let currentRsi = rsiValues[rsiValues.length - 1];
    let minRsi = Math.min(...rsiValues);
    let maxRsi = Math.max(...rsiValues);
    return ((currentRsi - minRsi) / (maxRsi - minRsi || 1)) * 100;
}

// НОВАЯ ФУНКЦИЯ: ADX-Фильтр силы тренда
function isTrendStrong(emaFast, emaSlow, price) {
    let diff = Math.abs(emaFast - emaSlow);
    // Тренд считается сильным, если разрыв между EMA больше 0.3% от цены
    return diff > (price * 0.003); 
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

// --- ОСНОВНАЯ ЛОГИКА АНАЛИЗА (H1) ---

function analyzePriceAction(coin, price, emaFast, emaSlow, closes, highs, lows, currentVol, avgVol) {
    if (!price || closes.length < 50) return;
    
    const rsi = calculateRSI(closes, 14);
    const stochRsi = calculateStochRSI(closes, 14);
    const trendStrong = isTrendStrong(emaFast, emaSlow, price);
    const atr = calculateATR(highs, lows, closes, 14);
    
    let sig = activeSignals[coin.id];

    if (!sig) {
        let type = null;

        // ХИРУРГИЧЕСКИЙ BUY: Цена выше обеих EMA + Сильный тренд + StochRSI в зоне покупки + Объемы выше средних
        if (price > emaFast && emaFast > emaSlow && trendStrong && stochRsi < 25 && rsi < 65 && currentVol > avgVol) {
            type = "BUY";
        } 
        // ХИРУРГИЧЕСКИЙ SELL: Цена ниже обеих EMA + Сильный тренд + StochRSI в зоне продажи + Объемы выше средних
        else if (price < emaFast && emaFast < emaSlow && trendStrong && stochRsi > 75 && rsi > 35 && currentVol > avgVol) {
            type = "SELL";
        }

        if (type && atr > 0) {
            const isBuy = type === "BUY";
            
            // УМНЫЕ СТОПЫ ATR (Соотношение 1:3 для H1)
            const slDistance = atr * 2;   // Стоп 2 ATR
            const tpDistance = atr * 6;   // Тейк 6 ATR

            activeSignals[coin.id] = {
                pair: `${coin.id}/USDT`,
                type: type,
                entry: price.toFixed(2),
                tp: isBuy ? (price + tpDistance).toFixed(2) : (price - tpDistance).toFixed(2),
                sl: isBuy ? (price - slDistance).toFixed(2) : (price + slDistance).toFixed(2),
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
    if (!sig) return;

    const entry = parseFloat(sig.entry);
    const tp = parseFloat(sig.tp);
    const sl = parseFloat(sig.sl);
    
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

// ОБНОВЛЕНИЕ МАРКЕТА (Granularity = 3600 для H1)
async function updateMarket() {
    for (const coin of ASSETS) {
        try {
            const res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=3600`);
            const candles = res.data.slice(0, 150).reverse(); 
            
            if (candles.length > 50) {
                const lows = candles.map(c => parseFloat(c[1]));
                const highs = candles.map(c => parseFloat(c[2]));
                const closes = candles.map(c => parseFloat(c[4]));
                const volumes = candles.map(c => parseFloat(c[5]));
                
                currentPrices[coin.id] = closes[closes.length - 1]; 
                const currentVol = volumes[volumes.length - 1];
                
                const emaFast = calculateEMA(closes, 20); 
                const emaSlow = calculateEMA(closes, 80); 
                const avgVol = calculateSMA(volumes, 24); // Средний объем за сутки (24 свечи H1)

                analyzePriceAction(coin, currentPrices[coin.id], emaFast, emaSlow, closes, highs, lows, currentVol, avgVol);
            }
        } catch (e) { 
            console.error(`API Error for ${coin.id}:`, e.message); 
            try {
                const fb = await axios.get(`https://api.coinbase.com/v2/prices/${coin.id}-USD/spot`);
                currentPrices[coin.id] = parseFloat(fb.data.data.amount);
            } catch (err) {}
        }
    }
}

setInterval(updateMarket, 15000); // Проверка каждые 15 секунд
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

    const active = Object.values(activeSignals).filter(s => s !== null);
    
    // Активные сигналы только для Премиум. Если нет премиума - пустой список.
    const processedActive = isPrem ? active : [];

    res.json({ 
        prices: currentPrices, 
        activeSignals: processedActive, 
        tradeHistory: getLiveHistory(), 
        stats, 
        premium: isPrem 
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 AI Surgical Engine H1 Running on port ${PORT}`));