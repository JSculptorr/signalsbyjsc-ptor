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
        console.log("✅ [SUCCESS]: Хирург v7.0 INSTITUTIONAL подключен к БД");
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

// --- РАСШИРЕННЫЙ СПИСОК ТОП-МОНЕТ (24 АКТИВА) ---
const ASSETS = [
    { id: 'BTC', symbol: 'BTCUSDT' }, { id: 'ETH', symbol: 'ETHUSDT' },
    { id: 'SOL', symbol: 'SOLUSDT' }, { id: 'LINK', symbol: 'LINKUSDT' },
    { id: 'BNB', symbol: 'BNBUSDT' }, { id: 'XRP', symbol: 'XRPUSDT' },
    { id: 'ADA', symbol: 'ADAUSDT' }, { id: 'DOGE', symbol: 'DOGEUSDT' },
    { id: 'AVAX', symbol: 'AVAXUSDT' }, { id: 'SHIB', symbol: 'SHIBUSDT' },
    { id: 'DOT', symbol: 'DOTUSDT' }, { id: 'NEAR', symbol: 'NEARUSDT' },
    { id: 'LTC', symbol: 'LTCUSDT' }, { id: 'BCH', symbol: 'BCHUSDT' },
    { id: 'UNI', symbol: 'UNIUSDT' }, { id: 'ATOM', symbol: 'ATOMUSDT' },
    { id: 'PEPE', symbol: 'PEPEUSDT' }, { id: 'APT', symbol: 'APTUSDT' },
    { id: 'RENDER', symbol: 'RENDERUSDT' }, { id: 'FIL', symbol: 'FILUSDT' },
    { id: 'OP', symbol: 'OPUSDT' }, { id: 'ARB', symbol: 'ARBUSDT' },
    { id: 'TIA', symbol: 'TIAUSDT' }, { id: 'INJ', symbol: 'INJUSDT' }
];

let currentPrices = {};
let activeSignals = {}; 
let marketStructure = {}; 

ASSETS.forEach(asset => {
    currentPrices[asset.id] = 0; activeSignals[asset.id] = null;
    marketStructure[asset.id] = { 
        htfHigh: 0, htfLow: 0, 
        lastOI: 0, 
        volumePOC: 0, 
        swept: false, 
        equilibrium: 0, 
        dailyBias: 'SIDEWAYS' 
    };
});

let tradeHistory = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: 0, avgRR: 0, streak: 0 };

function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', SWEEP: '🚨', MSS: '⚡', ENTRY: '🎯', ERROR: '⚠️', INSTITUTIONAL: '🏦' };
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
        stats = { total: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: "0.0", avgRR: "0.0", streak: 0 };
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

// --- НОВОЕ ЯДРО АНАЛИЗА: INSTITUTIONAL FLOW v7.0 ---
async function processSurgicalRadar() {
    const hour = new Date().getUTCHours();
    // Kill-Zones: Лондон (7-11 UTC) и Нью-Йорк (13-16 UTC)
    const isKillZone = (hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 16);

    for (const coin of ASSETS) {
        try {
            // Запрос данных фьючерсов (Цена + Открытый интерес)
            const resPrice = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=1m&limit=5`);
            const resOI = await axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`);
            
            const ticks = resPrice.data;
            const price = parseFloat(ticks[ticks.length - 1][4]);
            const currentOI = parseFloat(resOI.data.openInterest);
            currentPrices[coin.id] = price;

            if (activeSignals[coin.id]) { 
                checkTradeExecution(coin, price); 
                continue; 
            }

            if (!isKillZone) continue; 

            const struct = marketStructure[coin.id];
            
            // Если дневной контекст не определен, пропускаем
            if (struct.dailyBias === 'SIDEWAYS') continue; 

            // 1. ДЕТЕКТОР СВИПА HTF (Previous Day High / Low)
            let isSweep = false;
            let side = '';

            if (price > struct.htfHigh && struct.htfHigh > 0) {
                isSweep = true; side = 'SHORT';
            } else if (price < struct.htfLow && struct.htfLow > 0) {
                isSweep = true; side = 'LONG';
            }

            if (isSweep) {
                // 2. ФИЛЬТР MONEY FLOW (Open Interest Divergence)
                // Если цена обновляет хай/лой, но интерес падает — это подтверждение разворота
                const oiChange = ((currentOI - struct.lastOI) / struct.lastOI) * 100;
                const isInstitutionalConfirm = oiChange < 0; 

                if (isInstitutionalConfirm) {
                    const lastCandle = ticks[ticks.length - 1];
                    const volume = parseFloat(lastCandle[5]);
                    
                    // 3. ФИЛЬТР ОБЪЕМА (Institutional POC Breach)
                    // Объем должен быть в 1.5 раза выше среднего минутного объема вчера
                    if (volume > struct.volumePOC * 1.5) {
                        broadcastHackerLog(`${coin.id}: захват PDH/PDL ликвидности подтвержден. OI Drop: ${oiChange.toFixed(2)}%`, 'INSTITUTIONAL');
                        await createSurgicalSignal(coin, price, side);
                    }
                }
            }
            // Сохраняем OI для следующего сравнения
            struct.lastOI = currentOI;

        } catch (e) { }
    }
}

async function createSurgicalSignal(coin, price, side) {
    const slDist = price * 0.005; 
    const sl = side === 'LONG' ? price - slDist : price + slDist;
    // МАТЕМАТИКА RR 1:2 УСТАНОВЛЕНА ДЛЯ ВЫСОКОЙ ТОЧНОСТИ
    const tp = side === 'LONG' ? price + slDist * 2 : price - slDist * 2; 
    const posSize = 100 / Math.abs(price - sl); 

    const newSig = new ActiveSignal({
        coinId: coin.id, pair: `${coin.id}/USDT`, 
        type: side === 'LONG' ? `🏦 ${coin.id} LONG` : `🏦 ${coin.id} SHORT`,
        entry: price, sl, tp, size: posSize, desc: `INSTITUTIONAL v7.0 | OI & PDH/PDL Flow`
    });
    
    await newSig.save();
    activeSignals[coin.id] = { ...newSig._doc, status: "active" };
    broadcastHackerLog(`🎯 ВХОД: ${coin.id} ${side} по ${price}`, 'ENTRY');
    sendVipNotifications(coin.id, side, 10);
}

// ОБНОВЛЕНИЕ HTF УРОВНЕЙ (Ежедневный расчет PDH/PDL)
async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            // Получаем дневную свечу (вчерашнюю)
            const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${asset.symbol}&interval=1d&limit=2`);
            const prevDay = res.data[0]; 
            const struct = marketStructure[asset.id];
            
            struct.htfHigh = parseFloat(prevDay[2]); // Вчерашний Максимум (PDH)
            struct.htfLow = parseFloat(prevDay[3]);  // Вчерашний Минимум (PDL)
            struct.equilibrium = (struct.htfHigh + struct.htfLow) / 2;
            
            // Рассчитываем средний объем в минуту за вчера для фильтра POC
            struct.volumePOC = parseFloat(prevDay[5]) / 1440;

            const close = parseFloat(prevDay[4]);
            const open = parseFloat(prevDay[1]);
            struct.dailyBias = (close > open) ? 'UP' : 'DOWN';

            // Базовый OI
            const resOI = await axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${asset.symbol}`);
            struct.lastOI = parseFloat(resOI.data.openInterest);

            broadcastHackerLog(`${asset.id}: уровни PDH/PDL и контекст Bias обновлены.`, 'INFO');
        } catch (e) { }
    }
}

async function sendVipNotifications(coinId, side, score) {
    try {
        const vipUsers = await User.find({ subscriptionStatus: "active" });
        const subscriptions = await PushSubscription.find({ userId: { $in: vipUsers.map(u => u._id) } });
        const payload = JSON.stringify({ title: `JSculptor Institutional v7.0`, body: `${side} сигнал по ${coinId} сформирован!` });
        subscriptions.forEach(subDoc => webpush.sendNotification(subDoc.subscription, payload).catch(() => {}));
    } catch (err) {}
}

function checkTradeExecution(coin, price) {
    const sig = activeSignals[coin.id];
    if (!sig) return;
    const entry = parseFloat(sig.entry), tp = parseFloat(sig.tp), isLong = sig.type.includes('LONG');
    const totalDist = Math.abs(tp - entry), currentDist = Math.abs(price - entry);
    const progressPercent = (currentDist / totalDist) * 100;

    // Безубыток на 40% движения для безопасности
    if (progressPercent >= 40 && !sig.partialHit) {
        sig.sl = entry; sig.partialHit = true; 
        broadcastHackerLog(`${coin.id}: 40% цели взято. Стоп переведен в БЕЗУБЫТОК.`, 'INFO');
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

app.get('/api/proxy/candles', async (req, res) => {
    const { symbol, interval, limit } = req.query;
    try {
        const response = await axios.get(`https://data-api.binance.vision/api/v3/klines`, {
            params: { symbol: symbol || 'BTCUSDT', interval: interval || '1h', limit: limit || 100 }
        });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: "Binance Connection Failed" });
    }
});

app.post('/api/push/subscribe', async (req, res) => {
    const { token, subscription } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        await PushSubscription.findOneAndUpdate(
            { userId: decoded.id },
            { userId: decoded.id, subscription },
            { upsert: true }
        );
        res.json({ message: "Subscribed!" });
    } catch (e) { res.status(401).json({ error: "Auth failed" }); }
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

// СКАНЕР INSTITUTIONAL FLOW: каждые 10 секунд
setInterval(processSurgicalRadar, 10000); 
updateHtfLevels();
// Обновление дневных уровней каждый час
setInterval(updateHtfLevels, 3600000); 

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> JSCULPTOR INSTITUTIONAL v7.0 <<< `);
    console.log(`=========================================`);
    console.log(`📡 Bank Flow Analysis Live on port ${PORT}`);
});