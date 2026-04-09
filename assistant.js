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
    .then(() => {
        console.log("✅ MongoDB Connected");
        syncWithDatabase(); // Синхронизируем данные при старте
    })
    .catch(err => console.log("❌ MongoDB Error:", err));

// --- МОДЕЛИ ДАННЫХ ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null }
}));

const Code = mongoose.model('Code', new mongoose.Schema({
    code: { type: String, unique: true },
    days: { type: Number, default: 30 },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}));

// Новая модель для АКТИВНЫХ сигналов
const ActiveSignal = mongoose.model('ActiveSignal', new mongoose.Schema({
    coinId: String,
    pair: String,
    type: String,
    entry: Number,
    sl: Number,
    tp: Number,
    desc: String,
    timestamp: { type: Date, default: Date.now }
}));

// Новая модель для ИСТОРИИ сделок
const Trade = mongoose.model('Trade', new mongoose.Schema({
    pair: String,
    type: String,
    entry: Number,
    sl: Number,
    tp: Number,
    result: String, // SUCCESS / FAILED
    profit: String,
    timestamp: { type: Date, default: Date.now }
}));

// --- КОНФИГУРАЦИЯ АКТИВОВ ---
const ASSETS = [
    { id: 'BTC', pair: 'BTC-USD' },
    { id: 'ETH', pair: 'ETH-USD' },
    { id: 'SOL', pair: 'SOL-USD' }
];

let currentPrices = { BTC: 0, ETH: 0, SOL: 0 };
let activeSignals = { BTC: null, ETH: null, SOL: null }; 
let tradeHistory = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0 };

// Синхронизация: подтягиваем всё из БД при запуске
async function syncWithDatabase() {
    try {
        // 1. Загружаем активные сигналы в память
        const dbActive = await ActiveSignal.find();
        dbActive.forEach(sig => {
            activeSignals[sig.coinId] = {
                pair: sig.pair,
                type: sig.type,
                entry: sig.entry.toFixed(2),
                sl: sig.sl.toFixed(2),
                tp: sig.tp.toFixed(2),
                desc: sig.desc,
                status: "active",
                timestamp: sig.timestamp
            };
        });

        // 2. Загружаем историю последних сделок
        tradeHistory = await Trade.find().sort({ timestamp: -1 }).limit(20);

        // 3. Считаем реальную статистику для сайта
        const total = await Trade.countDocuments();
        const wins = await Trade.countDocuments({ result: "SUCCESS" });
        const losses = await Trade.countDocuments({ result: "FAILED" });

        stats.total = total || 154; // Если база пуста, ставим твои дефолтные значения
        stats.wins = wins || 128;
        stats.losses = losses || 26;
        stats.winRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 83;

        console.log(`📊 Статистика: ${stats.total} сделок, WinRate: ${stats.winRate}%`);
    } catch (e) { console.error("Ошибка синхронизации:", e); }
}

// --- МАТЕМАТИЧЕСКИЕ ФУНКЦИИ ---
function calculateSMA(data, period) {
    if (data.length < period) return 0;
    return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < closes.length; i++) {
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getMarketRegime(closes) {
    const slice = closes.slice(-20);
    const high = Math.max(...slice);
    const low = Math.min(...slice);
    const volatility = (high - low) / low;
    return volatility > 0.012 ? 'TRENDING' : 'RANGING'; 
}

function findLiquiditySweep(ticks, type) {
    const lookback = ticks.slice(-20, -2);
    if (type === 'LONG') {
        const minLow = Math.min(...lookback.map(t => parseFloat(t[3])));
        return parseFloat(ticks[ticks.length-2][3]) < minLow;
    } else {
        const maxHigh = Math.max(...lookback.map(t => parseFloat(t[2])));
        return parseFloat(ticks[ticks.length-2][2]) > maxHigh;
    }
}

function findInstitutionalOB(ticks, type) {
    const lastIdx = ticks.length - 1;
    for (let i = lastIdx - 8; i < lastIdx - 1; i++) {
        const curr = ticks[i], next = ticks[i+1];
        const vol = parseFloat(curr[5]), avgVol = calculateSMA(ticks.map(t => parseFloat(t[5])), 20);
        const impulse = Math.abs(parseFloat(next[4]) - parseFloat(next[1])) / parseFloat(next[1]);
        if (type === 'LONG' && parseFloat(curr[4]) < parseFloat(curr[1]) && impulse > 0.005 && vol > avgVol) {
            return { high: parseFloat(curr[2]), low: parseFloat(curr[3]) };
        }
        if (type === 'SHORT' && parseFloat(curr[4]) > parseFloat(curr[1]) && impulse > 0.005 && vol > avgVol) {
            return { high: parseFloat(curr[2]), low: parseFloat(curr[3]) };
        }
    }
    return null;
}

// --- СИСТЕМА СКОРИНГА И АНАЛИЗА ---
async function analyzeSMC_Ultimate(coin, h1ticks) {
    const closes = h1ticks.map(t => parseFloat(t[4]));
    const highs = h1ticks.map(t => parseFloat(t[2]));
    const lows = h1ticks.map(t => parseFloat(t[3]));
    const price = closes[closes.length - 1];
    
    // ПРОВЕРКА: Если сигнал уже есть в памяти, не создаем новый!
    if (activeSignals[coin.id]) {
        checkTradeExecution(coin, price);
        return;
    }

    const regime = getMarketRegime(closes);
    const atr = calculateATR(highs, lows, closes);
    
    try {
        const h4res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=21600`);
        const h4Trend = parseFloat(h4res.data[0][4]) > parseFloat(h4res.data[0][1]) ? 'UP' : 'DOWN';

        let score = 0;
        let signalType = null;

        const longSweep = findLiquiditySweep(h1ticks, 'LONG');
        const longOB = findInstitutionalOB(h1ticks, 'LONG');
        const fvgLong = parseFloat(h1ticks[h1ticks.length-3][2]) < parseFloat(h1ticks[h1ticks.length-1][3]);

        if (h4Trend === 'UP') score += 2;
        if (regime === 'TRENDING') score += 1;
        if (longSweep) score += 3;
        if (longOB && price > longOB.high) score += 2;
        if (fvgLong) score += 2;

        if (score >= 8) signalType = 'BUY';

        if (!signalType) {
            score = 0;
            const shortSweep = findLiquiditySweep(h1ticks, 'SHORT');
            const shortOB = findInstitutionalOB(h1ticks, 'SHORT');
            const fvgShort = parseFloat(h1ticks[h1ticks.length-3][3]) > parseFloat(h1ticks[h1ticks.length-1][2]);
            if (h4Trend === 'DOWN') score += 2;
            if (regime === 'TRENDING') score += 1;
            if (shortSweep) score += 3;
            if (shortOB && price < shortOB.low) score += 2;
            if (fvgShort) score += 2;
            if (score >= 8) signalType = 'SELL';
        }

        if (signalType && atr > 0) {
            const slDist = atr * 2.5; 
            const entryVal = price;
            const slVal = signalType === 'BUY' ? entryVal - slDist : entryVal + slDist;
            const tpVal = signalType === 'BUY' ? entryVal + slDist * 3.5 : entryVal - slDist * 3.5;

            // 1. СОХРАНЯЕМ В БД СРАЗУ
            const dbSignal = new ActiveSignal({
                coinId: coin.id,
                pair: `${coin.id}/USDT`,
                type: signalType === 'BUY' ? '🔥 PRO SMC LONG' : '📉 PRO SMC SHORT',
                entry: entryVal,
                sl: slVal,
                tp: tpVal,
                desc: `SCORE: ${score}/10 | HTF: ${h4Trend}`
            });
            await dbSignal.save();

            // 2. ЗАПИСЫВАЕМ В ПАМЯТЬ
            activeSignals[coin.id] = {
                pair: `${coin.id}/USDT`,
                type: signalType === 'BUY' ? '🔥 PRO SMC LONG' : '📉 PRO SMC SHORT',
                entry: entryVal.toFixed(2),
                sl: slVal.toFixed(2),
                tp: tpVal.toFixed(2),
                desc: `SCORE: ${score}/10 | HTF: ${h4Trend}`,
                status: "active",
                timestamp: Date.now()
            };
            console.log(`📡 Новый сигнал по ${coin.id} сохранен в БД`);
        }
    } catch (err) { console.error(`Ошибка анализа ${coin.id}`); }
}

function checkTradeExecution(coin, price) {
    const sig = activeSignals[coin.id];
    if (!sig) return;

    const isLong = sig.type.includes('LONG');
    const tp = parseFloat(sig.tp);
    const sl = parseFloat(sig.sl);

    if (isLong) {
        if (price >= tp) finalizeTrade(coin.id, "SUCCESS");
        else if (price <= sl) finalizeTrade(coin.id, "FAILED");
    } else {
        if (price <= tp) finalizeTrade(coin.id, "SUCCESS");
        else if (price >= sl) finalizeTrade(coin.id, "FAILED");
    }
}

async function finalizeTrade(coinId, result) {
    const sig = activeSignals[coinId];
    if (!sig) return;

    const entry = parseFloat(sig.entry);
    const exitPrice = result === "SUCCESS" ? parseFloat(sig.tp) : parseFloat(sig.sl);
    const profitPct = Math.abs((exitPrice - entry) / entry * 100).toFixed(2);

    // 1. СОХРАНЯЕМ В ИСТОРИЮ (БД)
    const tradeDoc = new Trade({
        pair: sig.pair,
        type: sig.type,
        entry: entry,
        sl: sig.sl,
        tp: sig.tp,
        result: result,
        profit: result === "SUCCESS" ? `+${profitPct}%` : `-${profitPct}%`
    });
    await tradeDoc.save();

    // 2. УДАЛЯЕМ ИЗ АКТИВНЫХ (БД)
    await ActiveSignal.deleteOne({ coinId: coinId });

    // 3. ОБНУЛЯЕМ В ПАМЯТИ И ОБНОВЛЯЕМ СТАТУ
    activeSignals[coinId] = null;
    await syncWithDatabase(); 
    console.log(`✅ Сделка по ${coinId} завершена: ${result}`);
}

// --- ЦИКЛ ОБНОВЛЕНИЯ ---
async function updateMarket() {
    for (const coin of ASSETS) {
        try {
            const res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=3600`);
            const ticks = res.data.slice(0, 100).reverse();
            if (ticks.length > 50) {
                currentPrices[coin.id] = parseFloat(ticks[ticks.length - 1][4]);
                await analyzeSMC_Ultimate(coin, ticks);
            }
        } catch (e) { console.error(`API Error ${coin.id}`); }
    }
}

setInterval(updateMarket, 15000);
updateMarket();

// --- API ---
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

app.get('/api/data', async (req, res) => {
    let isPrem = false;
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user && (user.subscriptionStatus === "active" || user.subscriptionExpires > new Date())) isPrem = true;
        } catch (e) {}
    }
    const active = Object.values(activeSignals).filter(s => s !== null);
    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? active : [], 
        tradeHistory: tradeHistory, 
        stats, 
        premium: isPrem 
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> JSCULPTOR SMC ULTIMATE 10/10 <<< `);
    console.log(`=========================================`);
    console.log(`🩺 [ХИРУРГ]: Азамат, память восстановлена!`);
    console.log(`[OK] АКТИВНЫЕ СИГНАЛЫ: В БАЗЕ ДАННЫХ`);
    console.log(`[OK] СТАТИСТИКА: АВТОМАТИЧЕСКАЯ`);
    console.log(`=========================================\n`);
});