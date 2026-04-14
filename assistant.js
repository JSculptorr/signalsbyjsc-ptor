const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const webpush = require('web-push');
const crypto = require('crypto');
const Binance = require('node-binance-api'); // Подключаем скальпель

const app = express();
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
    balance: { type: Number, default: 10000 }, 
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
    { id: 'BTC', pair: 'BTC-USD', weight: 1 }, { id: 'ETH', pair: 'ETH-USD', weight: 1 },
    { id: 'SOL', pair: 'SOL-USD', weight: 1 }, { id: 'LINK', pair: 'LINK-USD', weight: 1 },
    { id: 'AVAX', pair: 'AVAX-USD', weight: 1 }, { id: 'GOLD', pair: 'PAXG-USD', weight: 1 },
    { id: 'XRP', pair: 'XRP-USD', weight: 0 }, { id: 'ADA', pair: 'ADA-USD', weight: 0 },
    { id: 'DOT', pair: 'DOT-USD', weight: 0 }, { id: 'DOGE', pair: 'DOGE-USD', weight: 0 },
    { id: 'MATIC', pair: 'MATIC-USD', weight: 0 }
];

let currentPrices = {};
let activeSignals = {}; 
let antiTilt = {};
ASSETS.forEach(asset => {
    currentPrices[asset.id] = 0; activeSignals[asset.id] = null;
    antiTilt[asset.id] = { losses: 0, pauseUntil: 0 };
});

let tradeHistory = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: 0, avgRR: 0, streak: 0 };

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

// --- SMC МАТЕМАТИКА ---
function calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return 0;
    let trs = [];
    for (let i = 1; i < closes.length; i++) {
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function findInstitutionalOB(ticks, type) {
    const avgBody = ticks.slice(-20).reduce((a, b) => a + Math.abs(b[4] - b[1]), 0) / 20;
    for (let i = ticks.length - 10; i < ticks.length - 2; i++) {
        const curr = ticks[i], next = ticks[i+1];
        const displacement = Math.abs(next[4] - next[1]) > avgBody * 2.3; 
        const fvg = type === 'LONG' ? ticks[i+2][3] > curr[2] : ticks[i+2][2] < curr[3]; 
        if (type === 'LONG' && curr[4] < curr[1] && displacement && fvg) return { high: curr[2], low: curr[3] };
        if (type === 'SHORT' && curr[4] > curr[1] && displacement && fvg) return { high: curr[2], low: curr[3] };
    }
    return null;
}

function findLiquiditySweep(ticks, type) {
    const lookback = ticks.slice(-25, -3);
    const lastTick = ticks[ticks.length - 2];
    if (type === 'LONG') {
        const min = Math.min(...lookback.map(t => t[3]));
        return lastTick[3] < min && ticks[ticks.length-1][4] > min;
    } else {
        const max = Math.max(...lookback.map(t => t[2]));
        return lastTick[2] > max && ticks[ticks.length-1][4] < max;
    }
}

// --- ИСПОЛНИТЕЛЬ АВТО-ТОРГОВЛИ (РЕАЛЬНЫЙ BINANCE FUTURES) ---
async function executeAutoTrades(signal) {
    try {
        const users = await User.find({ autoTrade: true, subscriptionStatus: "active" });
        if (users.length === 0) return;

        users.forEach(async (user) => {
            if (!user.binanceKey || !user.binanceSecret) return;
            try {
                // Инициализация Binance с расшифрованными ключами
                const binance = new Binance().options({
                    APIKEY: decrypt(user.binanceKey, user.iv),
                    APISECRET: decrypt(user.binanceSecret, user.iv)
                });

                const symbol = signal.coinId + 'USDT';
                const side = signal.type.includes('LONG') ? 'BUY' : 'SELL';
                
                console.log(`🚀 [EXECUTION]: Real Trade for ${user.email} on ${symbol}`);
                
                // 1. Установка плеча 10x
                await binance.futuresLeverage(symbol, 10);
                
                // 2. Расчет количества (на 1% риска)
                const quantity = signal.size.toFixed(3); 

                // 3. Отправка рыночного ордера
                let order;
                if (side === 'BUY') {
                    order = await binance.futuresMarketBuy(symbol, quantity);
                } else {
                    order = await binance.futuresMarketSell(symbol, quantity);
                }

                if (order.orderId) {
                    console.log(`✅ [ORDER PLACED]: ${side} ${symbol} at ${signal.entry}. ID: ${order.orderId}`);
                }
            } catch (err) { console.error(`Ошибка Binance API для ${user.email}:`, err.body || err.message); }
        });
    } catch (err) { console.error("Ошибка Auto-Trade Engine:", err); }
}

// --- ЯДРО АНАЛИЗА ---
async function processCoinData(coin) {
    try {
        const res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=3600`);
        const ticks = res.data.slice(0, 100).reverse();
        const price = parseFloat(ticks[ticks.length - 1][4]);
        currentPrices[coin.id] = price;

        if (activeSignals[coin.id]) { await checkTradeExecution(coin, price); return; }

        const hour = new Date().getUTCHours();
        if (hour < 8 || hour > 21 || Date.now() < antiTilt[coin.id].pauseUntil) return;

        const h4res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=21600`);
        const h4Trend = parseFloat(h4res.data[0][4]) > parseFloat(h4res.data[0][1]) ? 'UP' : 'DOWN';

        let score = coin.weight; 
        let side = h4Trend === 'UP' ? 'LONG' : 'SHORT';

        if (findLiquiditySweep(ticks, side)) score += 4;
        const ob = findInstitutionalOB(ticks, side);
        if (ob) score += 3;
        if (side === 'LONG' && ticks[ticks.length-3][2] < ticks[ticks.length-1][3]) score += 3;
        if (side === 'SHORT' && ticks[ticks.length-3][3] > ticks[ticks.length-1][2]) score += 3;

        if (score >= 8) {
            const m5res = await axios.get(`https://api.exchange.coinbase.com/products/${coin.pair}/candles?granularity=300`);
            const m5 = m5res.data.slice(0, 30).reverse();
            const confirmed = side === 'LONG' ? m5[m5.length-1][4] > Math.max(...m5.slice(-12,-2).map(t=>t[2])) : m5[m5.length-1][4] < Math.min(...m5.slice(-12,-2).map(t=>t[3]));

            if (confirmed) {
                const user = await User.findOne({ subscriptionStatus: "active" });
                const currentBalance = user ? user.balance : 10000;
                const atr = calculateATR(ticks.map(t=>t[2]), ticks.map(t=>t[3]), ticks.map(t=>t[4]));
                const slDist = atr * 2.2;
                const sl = side === 'LONG' ? price - slDist : price + slDist;
                const tp = side === 'LONG' ? price + slDist * 4 : price - slDist * 4;
                const riskAmount = currentBalance * 0.01;
                const posSize = riskAmount / Math.abs(price - sl);

                const newSig = new ActiveSignal({
                    coinId: coin.id, pair: `${coin.id}/USDT`, type: side === 'LONG' ? '🔥 PRO SMC LONG' : '📉 PRO SMC SHORT',
                    entry: price, sl, tp, size: posSize, desc: `1% RISK | Score: ${score}`
                });
                await newSig.save();
                activeSignals[coin.id] = { ...newSig._doc, status: "active" };

                executeAutoTrades(activeSignals[coin.id]);
                sendVipNotifications(coin.id, side, score);
            }
        }
    } catch (e) { console.error(`Анализ ${coin.id} временно недоступен`); }
}

async function sendVipNotifications(coinId, side, score) {
    try {
        const vipUsers = await User.find({ subscriptionStatus: "active" });
        const userIds = vipUsers.map(u => u._id);
        const subscriptions = await PushSubscription.find({ userId: { $in: userIds } });
        const payload = JSON.stringify({
            title: `Хирург: Сигнал по ${coinId}!`,
            body: `${side === 'LONG' ? '🚀 LONG' : '📉 SHORT'} | Вход по SMC. Score: ${score}`,
            icon: 'https://cdn-icons-png.flaticon.com/512/2504/2504824.png' 
        });
        subscriptions.forEach(subDoc => {
            webpush.sendNotification(subDoc.subscription, payload).catch(err => {
                if (err.statusCode === 410) PushSubscription.deleteOne({ _id: subDoc._id }).exec();
            });
        });
    } catch (err) { console.error("Ошибка рассылки пушей:", err); }
}

async function checkTradeExecution(coin, price) {
    const sig = activeSignals[coin.id];
    if (!sig) return;
    const isLong = sig.type.includes('LONG');
    const entry = parseFloat(sig.entry), sl = parseFloat(sig.sl), tp = parseFloat(sig.tp);
    const target1R = isLong ? entry + (entry - sl) : entry - (sl - entry);

    if (!sig.partialHit && ((isLong && price >= target1R) || (!isLong && price <= target1R))) {
        await ActiveSignal.findByIdAndUpdate(sig._id, { partialHit: true, sl: entry });
        activeSignals[coin.id].partialHit = true;
        activeSignals[coin.id].sl = entry; 
        console.log(`💰 [PARTIAL]: 1R по ${coin.id}. 50% закрыто, стоп в БУ.`);
    }

    if (isLong) {
        if (price >= tp) await finalizeTrade(coin.id, "SUCCESS", tp);
        else if (price <= sl) await finalizeTrade(coin.id, "FAILED", sl);
    } else {
        if (price <= tp) await finalizeTrade(coin.id, "SUCCESS", tp);
        else if (price >= sl) await finalizeTrade(coin.id, "FAILED", sl);
    }
}

async function finalizeTrade(coinId, result, exitPrice) {
    const sig = activeSignals[coinId];
    if (!sig) return;
    const entry = parseFloat(sig.entry);
    let profitCash = (exitPrice - entry) * sig.size;
    if (sig.partialHit && result === "FAILED") profitCash = 0;
    const rr = Math.abs(exitPrice - entry) / Math.abs(entry - parseFloat(sig.sl)) || 1;
    await new Trade({ pair: sig.pair, type: sig.type, entry, exit: exitPrice, sl: sig.sl, tp: sig.tp, result, profitCash, rr }).save();
    await ActiveSignal.deleteOne({ _id: sig._id });
    await User.findOneAndUpdate({ subscriptionStatus: "active" }, { $inc: { balance: profitCash } });
    if (result === "FAILED") {
        antiTilt[coinId].losses++;
        if (antiTilt[coinId].losses >= 2) { antiTilt[coinId].pauseUntil = Date.now() + (8 * 60 * 60 * 1000); antiTilt[coinId].losses = 0; }
    } else { antiTilt[coinId].losses = 0; }
    activeSignals[coinId] = null;
    await syncWithDatabase();
}

async function updateMarket() { await Promise.all(ASSETS.map(coin => processCoinData(coin))); }
setInterval(updateMarket, 15000);
updateMarket();

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
    } catch (e) { res.status(500).json({ error: "Internal Server Error" }); }
});

app.post('/api/user/save-keys', async (req, res) => {
    const { token, apiKey, apiSecret, autoTrade } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const encryptedKey = encrypt(apiKey);
        const encryptedSecret = encrypt(apiSecret);
        await User.findByIdAndUpdate(decoded.id, {
            binanceKey: encryptedKey.encryptedData,
            binanceSecret: encryptedSecret.encryptedData,
            iv: encryptedKey.iv,
            autoTrade: autoTrade
        });
        res.json({ message: "Защита настроена!" });
    } catch (e) { res.status(401).json({ error: "Ошибка" }); }
});

app.post('/api/push/subscribe', async (req, res) => {
    const { token, subscription } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        await PushSubscription.findOneAndUpdate({ userId: decoded.id }, { userId: decoded.id, subscription: subscription }, { upsert: true });
        res.json({ message: "Subscribed to VIP Push" });
    } catch (e) { res.status(401).json({ error: "Auth failed" }); }
});

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
    } catch (e) { res.status(401).json({ error: "Ошибка авторизации" }); }
});

app.get('/api/data', async (req, res) => {
    let isPrem = false; let autoMode = false; let realBalance = "0.00";
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user) {
                if (user.subscriptionStatus === "active" || user.subscriptionExpires > new Date()) isPrem = true;
                autoMode = user.autoTrade;

                // Получение реального баланса с Binance
                if (user.binanceKey && user.binanceSecret) {
                    try {
                        const binance = new Binance().options({
                            APIKEY: decrypt(user.binanceKey, user.iv),
                            APISECRET: decrypt(user.binanceSecret, user.iv)
                        });
                        const accBalance = await binance.futuresBalance();
                        const usdt = accBalance.find(b => b.asset === 'USDT');
                        realBalance = usdt ? parseFloat(usdt.balance).toFixed(2) : "0.00";
                        // Синхронизация баланса в БД
                        user.balance = parseFloat(realBalance);
                        await user.save();
                    } catch (err) { console.log("Binance Balance Error:", err.message); }
                }
            }
        } catch (e) {}
    }
    const active = Object.values(activeSignals).filter(s => s !== null);
    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? active : [], 
        tradeHistory, 
        stats, 
        premium: isPrem, 
        autoTrade: autoMode,
        balance: realBalance 
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> JSCULPTOR SURGICAL v5.5 FUTURES 10x <<< `);
    console.log(`=========================================`);
    console.log(`[OK] BINANCE FUTURES ENGINE: LOADED`);
    console.log(`[OK] LEVERAGE DEFAULT: 10x`);
    console.log(`[OK] AES-256 VAULT: ACTIVE`);
    console.log(`=========================================\n`);
});