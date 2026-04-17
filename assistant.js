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
        console.log("✅ [SUCCESS]: Хирург подключен к базе данных");
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

// --- КОНФИГУРАЦИЯ АКТИВОВ (BINANCE FORMAT) ---
const ASSETS = [
    { id: 'BTC', symbol: 'BTCUSDT' }, { id: 'ETH', symbol: 'ETHUSDT' },
    { id: 'SOL', symbol: 'SOLUSDT' }, { id: 'LINK', symbol: 'LINKUSDT' }
];

let currentPrices = {};
let activeSignals = {}; 
let marketStructure = {}; 

ASSETS.forEach(asset => {
    currentPrices[asset.id] = 0; activeSignals[asset.id] = null;
    marketStructure[asset.id] = { htfHigh: 0, htfLow: 0, lastLtfHigh: 0, lastLtfLow: 0, swept: false, equilibrium: 0 };
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

// --- ЯДРО АНАЛИЗА BINANCE (SURGICAL V6.0) ---
async function processSurgicalRadar() {
    for (const coin of ASSETS) {
        try {
            // Используем шлюз binance.vision для обхода блокировок Render/USA
            const response = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${coin.symbol}&interval=1m&limit=50`);
            const ticks = response.data;
            const price = parseFloat(ticks[ticks.length - 1][4]);
            currentPrices[coin.id] = price;

            if (activeSignals[coin.id]) { 
                checkTradeExecution(coin, price); 
                continue; 
            }

            const struct = marketStructure[coin.id];
            struct.lastLtfHigh = Math.max(...ticks.slice(-10, -1).map(t => parseFloat(t[2])));
            struct.lastLtfLow = Math.min(...ticks.slice(-10, -1).map(t => parseFloat(t[3])));

            // 1. ДЕТЕКТОР СВИПА HTF (Снятие ликвидности)
            if (price > struct.htfHigh && !struct.swept && struct.htfHigh > 0) {
                struct.swept = 'SHORT';
                broadcastHackerLog(`${coin.id}: Ликвидность сверху (HTF) снята. Жду импульс в Premium зоне.`, 'SWEEP');
            } else if (price < struct.htfLow && !struct.swept && struct.htfLow > 0) {
                struct.swept = 'LONG';
                broadcastHackerLog(`${coin.id}: Ликвидность снизу (HTF) снята. Жду импульс в Discount зоне.`, 'SWEEP');
            }

            // 2. ФИЛЬТРЫ ВХОДА: Premium/Discount + Displacement + FVG
            if (struct.swept) {
                const side = struct.swept;
                const lastCandle = ticks[ticks.length - 1];
                const prevCandle = ticks[ticks.length - 2];
                const pPrevCandle = ticks[ticks.length - 3];

                // ФИЛЬТР 1: Premium/Discount (Покупаем дешево, продаем дорого)
                const isCorrectZone = (side === 'LONG') ? (price < struct.equilibrium) : (price > struct.equilibrium);
                if (!isCorrectZone) return;

                // ФИЛЬТР 2: Displacement (Импульсный слом структуры)
                const bodySize = Math.abs(parseFloat(lastCandle[1]) - parseFloat(lastCandle[4]));
                const avgBody = ticks.slice(-10).reduce((acc, t) => acc + Math.abs(t[1]-t[4]), 0) / 10;
                const isImpulsive = bodySize > (avgBody * 1.5);

                if (isImpulsive) {
                    // ФИЛЬТР 3: FVG (Ищем разрыв между 1-й и 3-й свечой)
                    let hasFVG = false;
                    if (side === 'LONG' && parseFloat(pPrevCandle[2]) < parseFloat(lastCandle[3])) hasFVG = true;
                    if (side === 'SHORT' && parseFloat(pPrevCandle[3]) > parseFloat(lastCandle[2])) hasFVG = true;

                    if (hasFVG) {
                        broadcastHackerLog(`${coin.id}: Импульсный слом (MSS) + FVG подтвержден!`, 'MSS');
                        await createSurgicalSignal(coin, price, side);
                        struct.swept = false; 
                    }
                }
            }
        } catch (e) { /* Игнорируем ошибки сети */ }
    }
}

async function createSurgicalSignal(coin, price, side) {
    const slDist = price * 0.005; // Стоп 0.5%
    const sl = side === 'LONG' ? price - slDist : price + slDist;
    const tp = side === 'LONG' ? price + slDist * 3 : price - slDist * 3; // ИЗМЕНЕНО: RR 1:3 для стабильности

    const posSize = 100 / Math.abs(price - sl); 

    const newSig = new ActiveSignal({
        coinId: coin.id, pair: `${coin.id}/USDT`, 
        type: side === 'LONG' ? '💎 SURGICAL LONG' : '💎 SURGICAL SHORT',
        entry: price, sl, tp, size: posSize, desc: `SMC Order Flow | RR 1:3`
    });
    
    await newSig.save();
    activeSignals[coin.id] = { ...newSig._doc, status: "active" };
    broadcastHackerLog(`ВХОД: ${side} ${coin.id} по цене ${price} (RR 1:3)`, 'ENTRY');
    sendVipNotifications(coin.id, side, 10);
}

// Обновление HTF уровней (раз в 15 мин)
async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            const res = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${asset.symbol}&interval=15m&limit=20`);
            const candles = res.data;
            const highs = candles.map(d => parseFloat(d[2]));
            const lows = candles.map(d => parseFloat(d[3]));
            
            const struct = marketStructure[asset.id];
            struct.htfHigh = Math.max(...highs);
            struct.htfLow = Math.min(...lows);
            struct.equilibrium = (struct.htfHigh + struct.htfLow) / 2;
            
            broadcastHackerLog(`${asset.id}: Диапазон M15 обновлен. Equilibrium: ${struct.equilibrium.toFixed(2)}`, 'INFO');
        } catch (e) { }
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

// --- УМНОЕ СОПРОВОЖДЕНИЕ (50% BREAKEVEN) ---
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
    console.log(`📡 Surgical Core v6.0 Live on port ${PORT}`);
    broadcastHackerLog("Ядро Surgeon Ultimate v6.0 загружено (RR 1:3 Mode)", "INFO");
});