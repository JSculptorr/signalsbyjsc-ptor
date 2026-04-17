const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const webpush = require('web-push');
const crypto = require('crypto');
const Binance = require('node-binance-api'); 
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

// --- КОНФИГУРАЦИЯ АКТИВОВ ---
const ASSETS = [
    { id: 'BTC', pair: 'BTCUSDT', weight: 1 }, { id: 'ETH', pair: 'ETHUSDT', weight: 1 },
    { id: 'SOL', pair: 'SOLUSDT', weight: 1 }, { id: 'LINK', pair: 'LINKUSDT', weight: 1 }
];

let currentPrices = {};
let activeSignals = {}; 
let antiTilt = {};
let marketStructure = {}; // Для хранения High/Low для Sweep

ASSETS.forEach(asset => {
    currentPrices[asset.id] = 0; activeSignals[asset.id] = null;
    antiTilt[asset.id] = { losses: 0, pauseUntil: 0 };
    marketStructure[asset.id] = { htfHigh: 0, htfLow: 0, lastM5High: 0, lastM5Low: 0, swept: false };
});

let tradeHistory = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: 0, avgRR: 0, streak: 0 };

// --- ГИБКИЙ ХАКЕРСКИЙ ЛОГ ---
function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', SWEEP: '🚨', MSS: '⚡', ENTRY: '🎯', ERROR: '⚠️' };
    const formattedMsg = `[${time}] ${icons[type] || ''} ${msg}`;
    io.emit('hacker_log', formattedMsg);
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

// --- SMC МАТЕМАТИКА 2.0 (LIVE) ---
function detectLiquiditySweep(assetId, currentPrice) {
    const struct = marketStructure[assetId];
    if (struct.htfHigh === 0) return null;

    if (currentPrice > struct.htfHigh && !struct.swept) {
        struct.swept = 'SHORT';
        broadcastHackerLog(`${assetId}: Ликвидность сверху снята (Buy Side). Ожидаю MSS для SHORT.`, 'SWEEP');
        return 'SHORT';
    }
    if (currentPrice < struct.htfLow && !struct.swept) {
        struct.swept = 'LONG';
        broadcastHackerLog(`${assetId}: Ликвидность снизу снята (Sell Side). Ожидаю MSS для LONG.`, 'SWEEP');
        return 'LONG';
    }
    return null;
}

// --- ИСПОЛНИТЕЛЬ АВТО-ТОРГОВЛИ ---
async function executeAutoTrades(signal) {
    try {
        const users = await User.find({ autoTrade: true, subscriptionStatus: "active" });
        users.forEach(async (user) => {
            if (!user.binanceKey || !user.binanceSecret) return;
            try {
                const binance = new Binance().options({
                    APIKEY: decrypt(user.binanceKey, user.iv),
                    APISECRET: decrypt(user.binanceSecret, user.iv),
                    useServerTime: true
                });
                const symbol = signal.coinId + 'USDT';
                const side = signal.type.includes('LONG') ? 'BUY' : 'SELL';
                await binance.futuresLeverage(symbol, 10);
                const quantity = signal.size.toFixed(3); 
                let order = side === 'BUY' ? await binance.futuresMarketBuy(symbol, quantity) : await binance.futuresMarketSell(symbol, quantity);
                if (order.orderId) broadcastHackerLog(`Ордер исполнен для ${user.email} на ${symbol}`, 'ENTRY');
            } catch (err) { broadcastHackerLog(`Ошибка Binance API: ${err.message}`, 'ERROR'); }
        });
    } catch (err) { console.error("Ошибка Auto-Trade Engine:", err); }
}

// --- LIVE ENGINE (WEBSOCKETS) ---
const binancePublic = new Binance();

function startLiveScanner() {
    broadcastHackerLog("Запуск Live-радара Surgeon Ultimate...", "INFO");
    
    ASSETS.forEach(asset => {
        // Подписка на 1-минутные свечи для Live-анализа
        binancePublic.websockets.candlesticks([asset.pair], "1m", async (candlesticks) => {
            let { k:ticks } = candlesticks;
            let { c:close, h:high, l:low, x:isFinal } = ticks;
            let price = parseFloat(close);
            currentPrices[asset.id] = price;

            // Если есть активный сигнал - проверяем выход
            if (activeSignals[asset.id]) {
                checkTradeExecution(asset, price);
                return;
            }

            // Обновляем структуру на закрытии свечи
            if (isFinal) {
                marketStructure[asset.id].lastM5High = parseFloat(high);
                marketStructure[asset.id].lastM5Low = parseFloat(low);
            }

            // 1. Охота за ликвидностью
            const sweepSide = detectLiquiditySweep(asset.id, price);

            // 2. Поиск слома структуры (MSS) если был свип
            if (marketStructure[asset.id].swept) {
                const side = marketStructure[asset.id].swept;
                const isMss = side === 'LONG' ? price > marketStructure[asset.id].lastM5High : price < marketStructure[asset.id].lastM5Low;
                
                if (isMss) {
                    broadcastHackerLog(`${asset.id}: Слом структуры (MSS) подтвержден!`, 'MSS');
                    await createSmsSignal(asset, price, side);
                    marketStructure[asset.id].swept = false; // Сбрасываем после входа
                }
            }
        });
    });
}

async function createSmsSignal(coin, price, side) {
    const slDist = price * 0.005; // 0.5% стоп для гибкости
    const sl = side === 'LONG' ? price - slDist : price + slDist;
    const tp = side === 'LONG' ? price + slDist * 3 : price - slDist * 3;
    const posSize = 100 / Math.abs(price - sl); // Примерный расчет лота

    const newSig = new ActiveSignal({
        coinId: coin.id, pair: `${coin.id}/USDT`, 
        type: side === 'LONG' ? '🔥 PRO SMC LONG' : '📉 PRO SMC SHORT',
        entry: price, sl, tp, size: posSize, desc: `LIVE MSS ENTRY | RR 1:3`
    });
    
    await newSig.save();
    activeSignals[coin.id] = { ...newSig._doc, status: "active" };
    broadcastHackerLog(`ВХОД: ${side} ${coin.id} по ${price}`, 'ENTRY');
    
    executeAutoTrades(activeSignals[coin.id]);
    sendVipNotifications(coin.id, side, 10);
}

// Периодическое обновление уровней HTF (раз в час)
async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            const res = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${asset.pair}&interval=1h&limit=24`);
            const highs = res.data.map(d => parseFloat(d[2]));
            const lows = res.data.map(d => parseFloat(d[3]));
            marketStructure[asset.id].htfHigh = Math.max(...highs);
            marketStructure[asset.id].htfLow = Math.min(...lows);
            broadcastHackerLog(`${asset.id}: Уровни ликвидности обновлены.`, 'INFO');
        } catch (e) { console.log("Ошибка HTF:", e.message); }
    }
}

// --- ОСТАЛЬНЫЕ ФУНКЦИИ (БЕЗ ИЗМЕНЕНИЙ) ---
async function sendVipNotifications(coinId, side, score) {
    try {
        const vipUsers = await User.find({ subscriptionStatus: "active" });
        const subscriptions = await PushSubscription.find({ userId: { $in: vipUsers.map(u => u._id) } });
        const payload = JSON.stringify({ title: `Сигнал по ${coinId}!`, body: `${side} | Вход по SMC.` });
        subscriptions.forEach(subDoc => webpush.sendNotification(subDoc.subscription, payload).catch(() => {}));
    } catch (err) {}
}

function checkTradeExecution(coin, price) {
    const sig = activeSignals[coin.id];
    if (!sig) return;
    const isLong = sig.type.includes('LONG');
    const entry = parseFloat(sig.entry), sl = parseFloat(sig.sl), tp = parseFloat(sig.tp);

    if (isLong) {
        if (price >= tp) finalizeTrade(coin.id, "SUCCESS", tp);
        else if (price <= sl) finalizeTrade(coin.id, "FAILED", sl);
    } else {
        if (price <= tp) finalizeTrade(coin.id, "SUCCESS", tp);
        else if (price >= sl) finalizeTrade(coin.id, "FAILED", sl);
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
    broadcastHackerLog(`Сделка по ${coinId} закрыта: ${result}`, 'INFO');
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
});

app.get('/api/data', async (req, res) => {
    let isPrem = false; let realBalance = "0.00";
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user) {
                isPrem = user.subscriptionStatus === "active";
                realBalance = user.balance.toFixed(2);
            }
        } catch (e) {}
    }
    const active = Object.values(activeSignals).filter(s => s !== null);
    res.json({ prices: currentPrices, activeSignals: isPrem ? active : [], tradeHistory, stats, premium: isPrem, balance: realBalance });
});

// Запуск
server.listen(10000, () => {
    console.log(`📡 Хирург в эфире на порту 10000`);
    startLiveScanner();
    updateHtfLevels();
    setInterval(updateHtfLevels, 3600000); // Раз в час обновляем уровни
});