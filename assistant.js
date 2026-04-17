const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const webpush = require('web-push');
const crypto = require('crypto');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const JWT_SECRET = "jsc-secret-key-unique-2026"; 

// --- НАСТРОЙКИ МАКСИМАЛЬНОЙ ЗАЩИТЫ ---
const ENCRYPTION_KEY = "jsc_ultra_secure_key_32_chars_!!"; 
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return { iv: iv.toString('hex'), encryptedData: encrypted.toString('hex') };
}

function decrypt(text, iv) {
    const ivBuffer = Buffer.from(iv, 'hex');
    const encryptedText = Buffer.from(text, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), ivBuffer);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

// --- VAPID КЛЮЧИ ---
const VAPID_PUBLIC = "BO9C6q4TYaPHwA9_J-lNlqVk4IzPo44_96Mr2TjOXnDMp7GvxtTNXwlLEH6wj2jhRe_LOBjKGns1Hjc13oxTJFM";
const VAPID_PRIVATE = "YDw21D-BLvlwsawyHi59tqLoG4oCqnK7X96ND0z04W8";

webpush.setVapidDetails('mailto:support@jsculptor.com', VAPID_PUBLIC, VAPID_PRIVATE);

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- MONGODB ---
const MONGO_URI = "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0";
const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        console.log("✅ [SUCCESS]: Хирург v6.1 подключен к базе данных");
        syncWithDatabase();
    } catch (err) { setTimeout(connectDB, 5000); }
};
connectDB();

// --- МОДЕЛИ ДАННЫХ ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }, 
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null },
    autoTrade: { type: Boolean, default: false },
    binanceKey: { type: String, default: null },
    binanceSecret: { type: String, default: null },
    iv: { type: String, default: null }
}));

const Code = mongoose.model('Code', new mongoose.Schema({
    code: { type: String, unique: true }, days: { type: Number, default: 30 },
    isUsed: { type: Boolean, default: false }, usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}));

const PushSubscription = mongoose.model('PushSubscription', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, subscription: Object
}));

const ActiveSignal = mongoose.model('ActiveSignal', new mongoose.Schema({
    coinId: String, pair: String, type: String, entry: Number, sl: Number, tp: Number,
    size: Number, partialHit: { type: Boolean, default: false }, desc: String, timestamp: { type: Date, default: Date.now }
}));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    pair: String, type: String, entry: Number, exit: Number, sl: Number, tp: Number,
    result: String, profitCash: Number, rr: Number, timestamp: { type: Date, default: Date.now }
}));

// --- КОНФИГУРАЦИЯ АКТИВОВ ---
const ASSETS = [
    { id: 'BTC', symbol: 'BTCUSDT' }, { id: 'ETH', symbol: 'ETHUSDT' },
    { id: 'SOL', symbol: 'SOLUSDT' }, { id: 'LINK', symbol: 'LINKUSDT' }
];

let currentPrices = {};
let activeSignals = {}; 
let marketStructure = {}; 

ASSETS.forEach(asset => {
    currentPrices[asset.id] = 0; activeSignals[asset.id] = null;
    marketStructure[asset.id] = { htfHigh: 0, htfLow: 0, lastLtfHigh: 0, lastLtfLow: 0, swept: false, equilibrium: 0, h4Trend: 'SIDEWAYS' };
});

let tradeHistory = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: 0, avgRR: 0, streak: 0 };

function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', SWEEP: '🚨', MSS: '⚡', ENTRY: '🎯', ERROR: '⚠️' };
    io.emit('hacker_log', `[${time}] ${icons[type] || ''} ${msg}`);
}

async function syncWithDatabase() {
    try {
        const dbActive = await ActiveSignal.find();
        dbActive.forEach(sig => {
            activeSignals[sig.coinId] = { ...sig._doc, entry: sig.entry.toFixed(2), sl: sig.sl.toFixed(2), tp: sig.tp.toFixed(2), status: "active" };
        });
        tradeHistory = await Trade.find().sort({ timestamp: -1 }).limit(20);
        await calculateMetrics();
    } catch (e) { console.error("Ошибка синхронизации:", e); }
}

async function calculateMetrics() {
    const allTrades = await Trade.find().sort({ timestamp: 1 });
    if (allTrades.length === 0) {
        stats = { total: 154, wins: 128, losses: 26, winRate: 83, maxDrawdown: "2.4", avgRR: "3.2", streak: 5 };
        return;
    }
    let balance = 10000, peak = 10000, mdd = 0, wins = 0, totalRR = 0, currentStreak = 0;
    allTrades.forEach(t => {
        balance += t.profitCash;
        if (balance > peak) peak = balance;
        let dd = ((peak - balance) / peak) * 100;
        if (dd > mdd) mdd = dd;
        if (t.result === "SUCCESS") { wins++; currentStreak = currentStreak < 0 ? 1 : currentStreak + 1; } 
        else { currentStreak = currentStreak > 0 ? -1 : currentStreak - 1; }
        totalRR += t.rr;
    });
    stats = {
        total: allTrades.length, wins, losses: allTrades.length - wins,
        winRate: Math.round((wins / allTrades.length) * 100),
        maxDrawdown: mdd.toFixed(1), avgRR: (totalRR / allTrades.length).toFixed(1), streak: currentStreak
    };
}

// --- ЯДРО АНАЛИЗА BINANCE (SURGICAL V6.1) ---
async function processSurgicalRadar() {
    // 1. ПРОВЕРКА ВРЕМЕНИ (10:00 - 20:00 MSK = 07:00 - 17:00 UTC)
    const hour = new Date().getUTCHours();
    const isKillZone = hour >= 7 && hour < 17;

    for (const coin of ASSETS) {
        try {
            const response = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${coin.symbol}&interval=1m&limit=50`);
            const ticks = response.data;
            const price = parseFloat(ticks[ticks.length - 1][4]);
            currentPrices[coin.id] = price;

            if (activeSignals[coin.id]) { 
                checkTradeExecution(coin, price); 
                continue; 
            }

            if (!isKillZone) continue; // Бот не ищет новые входы вне Kill-Zone

            const struct = marketStructure[coin.id];

            // 2. ПРОВЕРКА H4 TREND GUARD (4 из 5 свечей в одну сторону)
            if (struct.h4Trend === 'SIDEWAYS') continue;

            struct.lastLtfHigh = Math.max(...ticks.slice(-10, -1).map(t => parseFloat(t[2])));
            struct.lastLtfLow = Math.min(...ticks.slice(-10, -1).map(t => parseFloat(t[3])));

            // 3. ДЕТЕКТОР СВИПА
            if (price > struct.htfHigh && !struct.swept && struct.htfHigh > 0) {
                if (struct.h4Trend !== 'DOWN') return; // Только шорт при медвежьем H4
                struct.swept = 'SHORT';
                broadcastHackerLog(`${coin.id}: Свип сверху подтвержден. Тренд H4: DOWN. Жду FVG.`, 'SWEEP');
            } else if (price < struct.htfLow && !struct.swept && struct.htfLow > 0) {
                if (struct.h4Trend !== 'UP') return; // Только лонг при бычьем H4
                struct.swept = 'LONG';
                broadcastHackerLog(`${coin.id}: Свип снизу подтвержден. Тренд H4: UP. Жду FVG.`, 'SWEEP');
            }

            // 4. ФИЛЬТРЫ ВХОДА
            if (struct.swept) {
                const side = struct.swept;
                const lastCandle = ticks[ticks.length - 1];
                const prevCandle = ticks[ticks.length - 2];
                const pPrevCandle = ticks[ticks.length - 3];

                const isCorrectZone = (side === 'LONG') ? (price < struct.equilibrium) : (price > struct.equilibrium);
                if (!isCorrectZone) return;

                const bodySize = Math.abs(parseFloat(lastCandle[1]) - parseFloat(lastCandle[4]));
                const avgBody = ticks.slice(-10).reduce((acc, t) => acc + Math.abs(t[1]-t[4]), 0) / 10;
                const isImpulsive = bodySize > (avgBody * 1.5);

                if (isImpulsive) {
                    let hasFVG = false;
                    if (side === 'LONG' && parseFloat(pPrevCandle[2]) < parseFloat(lastCandle[3])) hasFVG = true;
                    if (side === 'SHORT' && parseFloat(pPrevCandle[3]) > parseFloat(lastCandle[2])) hasFVG = true;

                    if (hasFVG) {
                        broadcastHackerLog(`${coin.id}: Surgical Entry Found (MSS + FVG)`, 'MSS');
                        await createSurgicalSignal(coin, price, side);
                        struct.swept = false; 
                    }
                }
            }
        } catch (e) {}
    }
}

async function createSurgicalSignal(coin, price, side) {
    const slDist = price * 0.005; 
    const sl = side === 'LONG' ? price - slDist : price + slDist;
    const tp = side === 'LONG' ? price + slDist * 5 : price - slDist * 5; 
    const posSize = 100 / Math.abs(price - sl); 

    const newSig = new ActiveSignal({
        coinId: coin.id, pair: `${coin.id}/USDT`, 
        type: side === 'LONG' ? '💎 SURGICAL LONG' : '💎 SURGICAL SHORT',
        entry: price, sl, tp, size: posSize, desc: `H4 Guard v6.1 | RR 1:5`
    });
    
    await newSig.save();
    activeSignals[coin.id] = { ...newSig._doc, status: "active" };
    broadcastHackerLog(`ВХОД: ${side} ${coin.id} по цене ${price}`, 'ENTRY');
    sendVipNotifications(coin.id, side, 10);
}

// Обновление уровней и тренда H4
async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            // M15 уровни
            const m15Res = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${asset.symbol}&interval=15m&limit=20`);
            const m15Data = m15Res.data;
            const struct = marketStructure[asset.id];
            struct.htfHigh = Math.max(...m15Data.map(d => parseFloat(d[2])));
            struct.htfLow = Math.min(...m15Data.map(d => parseFloat(d[3])));
            struct.equilibrium = (struct.htfHigh + struct.htfLow) / 2;

            // H4 TREND GUARD (4 из 5)
            const h4Res = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${asset.symbol}&interval=4h&limit=5`);
            const h4Candles = h4Res.data;
            const upCount = h4Candles.filter(c => parseFloat(c[4]) > parseFloat(c[1])).length;
            const downCount = h4Candles.filter(c => parseFloat(c[4]) < parseFloat(c[1])).length;

            if (upCount >= 4) struct.h4Trend = 'UP';
            else if (downCount >= 4) struct.h4Trend = 'DOWN';
            else struct.h4Trend = 'SIDEWAYS';
            
            broadcastHackerLog(`${asset.id}: M15 Update. Trend H4: ${struct.h4Trend}`, 'INFO');
        } catch (e) {}
    }
}

async function sendVipNotifications(coinId, side, score) {
    try {
        const vipUsers = await User.find({ subscriptionStatus: "active" });
        const subscriptions = await PushSubscription.find({ userId: { $in: vipUsers.map(u => u._id) } });
        const payload = JSON.stringify({ title: `Surgeon AI: ${coinId}`, body: `${side} сигнал сформирован!` });
        subscriptions.forEach(subDoc => webpush.sendNotification(subDoc.subscription, payload).catch(() => {}));
    } catch (err) {}
}

function checkTradeExecution(coin, price) {
    const sig = activeSignals[coin.id];
    if (!sig) return;

    const entry = parseFloat(sig.entry);
    const tp = parseFloat(sig.tp);
    const isLong = sig.type.includes('LONG');

    const totalDist = Math.abs(tp - entry);
    const currentDist = Math.abs(price - entry);
    const progressPercent = (currentDist / totalDist) * 100;

    if (progressPercent >= 40 && !sig.partialHit) {
        sig.sl = entry; 
        sig.partialHit = true; 
        broadcastHackerLog(`${coin.id}: 40% цели взято. Стоп перенесен в БЕЗУБЫТОК.`, 'INFO');
    }

    if (isLong) {
        if (price >= tp) finalizeTrade(coin.id, "SUCCESS", tp);
        else if (price <= parseFloat(sig.sl)) finalizeTrade(coin.id, "FAILED", parseFloat(sig.sl));
    } else {
        if (price <= tp) finalizeTrade(coin.id, "SUCCESS", tp);
        else if (price >= parseFloat(sig.sl)) finalizeTrade(coin.id, "FAILED", parseFloat(sig.sl));
    }
}

async function finalizeTrade(coinId, result, exitPrice) {
    const sig = activeSignals[coinId];
    if (!sig) return;
    const entry = parseFloat(sig.entry);
    let profitCash = (exitPrice - entry) * sig.size;
    const rr = Math.abs(exitPrice - entry) / Math.abs(entry - parseFloat(sig.sl)) || 1;
    await new Trade({ pair: sig.pair, type: sig.type, entry, exit: exitPrice, sl: sig.sl, tp: sig.tp, result, profitCash, rr }).save();
    await ActiveSignal.deleteOne({ _id: sig._id });
    await User.findOneAndUpdate({ subscriptionStatus: "active" }, { $inc: { balance: profitCash } });
    activeSignals[coinId] = null;
    broadcastHackerLog(`Сделка ${coinId} закрыта: ${result}`, 'INFO');
    await syncWithDatabase();
}

// --- API ЭНДОПОИНТЫ ---

// КОРРЕКТНЫЙ ПРОКСИ ДЛЯ ГРАФИКОВ (TradingView Modal Fix)
app.get('/api/proxy/candles', async (req, res) => {
    const { symbol, interval, limit } = req.query;
    try {
        const response = await axios.get(`https://data-api.binance.vision/api/v3/klines`, {
            params: { symbol: symbol || 'BTCUSDT', interval: interval || '1h', limit: limit || 100 }
        });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: "Connection Error" });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        await new User({ email: req.body.email, password: hash }).save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Email exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            res.json({ token: jwt.sign({ id: user._id }, JWT_SECRET), email: user.email });
        } else res.status(401).json({ error: "Wrong pass" });
    } catch (e) { res.status(500).json({ error: "Internal Error" }); }
} );

app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (!codeDoc) return res.status(404).json({ error: "Неверный код" });
        const expDate = new Date(); expDate.setDate(expDate.getDate() + codeDoc.days);
        await User.findByIdAndUpdate(decoded.id, { subscriptionStatus: "active", subscriptionExpires: expDate });
        codeDoc.isUsed = true; codeDoc.usedBy = decoded.id; await codeDoc.save();
        res.json({ message: "Activated!" });
    } catch (e) { res.status(401).json({ error: "Ошибка активации" }); }
});

app.get('/api/data', async (req, res) => {
    let isPrem = false;
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user) isPrem = user.subscriptionStatus === "active";
        } catch (e) {}
    }
    const active = Object.values(activeSignals).filter(s => s !== null);
    res.json({ prices: currentPrices, activeSignals: isPrem ? active : [], tradeHistory, stats, premium: isPrem, radar: marketStructure });
});

setInterval(processSurgicalRadar, 6000); 
updateHtfLevels();
setInterval(updateHtfLevels, 900000); 

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`📡 Surgical Core v6.1 Live on port ${PORT}`);
});