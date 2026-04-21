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
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// Убираем предупреждение MaxListenersExceededWarning
require('events').EventEmitter.defaultMaxListeners = 100;

// --- CONFIGURATION (PRO-READY) ---
const CONFIG = {
    JWT_SECRET: process.env.JWT_SECRET || "jsc-secret-key-unique-2026",
    MONGO_URI: process.env.MONGO_URI || "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0",
    ENCRYPTION_KEY: "jsc_ultra_secure_key_32_chars_!!",
    ALGORITHM: 'aes-256-cbc',
    VAPID_PUBLIC: "BO9C6q4TYaPHwA9_J-lNlqVk4IzPo44_96Mr2TjOXnDMp7GvxtTNXwlLEH6wj2jhRe_LOBjKGns1Hjc13oxTJFM",
    VAPID_PRIVATE: "YDw21D-BLvlwsawyHi59tqLoG4oCqnK7X96ND0z04W8"
};

// --- INSTITUTIONAL ENCRYPTION SYSTEM (СОХРАНЕНО ПОЛНОСТЬЮ) ---
function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(CONFIG.ALGORITHM, Buffer.from(CONFIG.ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return { iv: iv.toString('hex'), encryptedData: encrypted.toString('hex') };
}

function decrypt(text, iv) {
    const ivBuffer = Buffer.from(iv, 'hex');
    const encryptedText = Buffer.from(text, 'hex');
    const decipher = crypto.createDecipheriv(CONFIG.ALGORITHM, Buffer.from(CONFIG.ENCRYPTION_KEY), ivBuffer);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

// --- VAPID PUSH NOTIFICATIONS (СОХРАНЕНО ПОЛНОСТЬЮ) ---
webpush.setVapidDetails('mailto:support@jsculptor.com', CONFIG.VAPID_PUBLIC, CONFIG.VAPID_PRIVATE);

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- MONGODB CLUSTER CONNECTION ---
const connectDB = async () => {
    try {
        await mongoose.connect(CONFIG.MONGO_URI, { 
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000 
        });
        console.log("✅ [TITAN FLOW]: Institutional Master Engine v8.8 Gold Online");
        syncWithDatabase();
    } catch (err) { 
        console.error("❌ DB Connection Error:", err);
        setTimeout(connectDB, 5000); 
    }
};
connectDB();

// --- DATA MODELS (ПОЛНЫЕ ВЕРСИИ) ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 }, 
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null },
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

const MasterSignal = mongoose.model('MasterSignal', new mongoose.Schema({
    coinId: String, pair: String, type: String, entry: Number, sl: Number, tp: Number,
    size: Number, partialHit: { type: Boolean, default: false }, 
    desc: String, confidence: Number, grade: String, timeLabel: String,
    reason: String, score: Number,
    timestamp: { type: Date, default: Date.now }
}));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    pair: String, type: String, entry: Number, exit: Number, sl: Number, tp: Number,
    result: String, profitCash: Number, rr: Number, grade: String, reason: String,
    timestamp: { type: Date, default: Date.now }
}));

// --- GLOBAL ASSETS (24 COINS + XAUUSDT GOLD) ---
const ASSETS = [
    { id: 'BTC', symbol: 'btcusdt' }, { id: 'ETH', symbol: 'ethusdt' },
    { id: 'SOL', symbol: 'solusdt' }, { id: 'LINK', symbol: 'linkusdt' },
    { id: 'BNB', symbol: 'bnbusdt' }, { id: 'XRP', symbol: 'xrpusdt' },
    { id: 'ADA', symbol: 'adausdt' }, { id: 'DOGE', symbol: 'dogeusdt' },
    { id: 'AVAX', symbol: 'avaxusdt' }, { id: 'SHIB', symbol: 'shibusdt' },
    { id: 'DOT', symbol: 'dotusdt' }, { id: 'NEAR', symbol: 'nearusdt' },
    { id: 'LTC', symbol: 'ltcusdt' }, { id: 'BCH', symbol: 'bchusdt' },
    { id: 'UNI', symbol: 'uniusdt' }, { id: 'ATOM', symbol: 'atomusdt' },
    { id: 'PEPE', symbol: 'pepeusdt' }, { id: 'APT', symbol: 'aptusdt' },
    { id: 'RENDER', symbol: 'renderusdt' }, { id: 'FIL', symbol: 'filusdt' },
    { id: 'OP', symbol: 'opusdt' }, { id: 'ARB', symbol: 'arbusdt' },
    { id: 'TIA', symbol: 'tiausdt' }, { id: 'INJ', symbol: 'injusdt' },
    { id: 'GOLD', symbol: 'xauusdt' } // Добавлено Золото 🏆
];

// --- MASTER STATE ---
let currentPrices = {};
let activeMasterSignals = {}; 
let tradeHistory = [];
let orderFlowTracker = {};

ASSETS.forEach(a => {
    orderFlowTracker[a.id] = {
        cvd: 0, lastCVD: 0, deltaVelocity: 0,
        absorptionBuffer: [], topBids: 0, topAsks: 0,
        htfHigh: 0, htfLow: 0, imbalance: 0,
        lastUpdate: Date.now(), sweepSide: null,
        currentScore: 0, 
        scoreDetails: [] // Детализация для Watchlist
    };
    currentPrices[a.id] = 0;
});

function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', SWEEP: '🚨', ABSORPTION: '🧱', ENTRY: '🎯', DELTA: '📊', MOMENTUM: '⚡' };
    io.emit('hacker_log', `[${time}] ${icons[type] || ''} ${msg}`);
}

// --- BINANCE WS ENGINE (INSTITUTIONAL MASTER) ---
function initTitanStream() {
    const streams = ASSETS.map(a => `${a.symbol}@aggTrade`).join('/') + '/' + 
                    ASSETS.map(a => `${a.symbol}@depth20@100ms`).join('/');
    
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', (data) => {
        const payload = JSON.parse(data);
        const [symbol, type] = payload.stream.split('@');
        const asset = ASSETS.find(a => a.symbol === symbol);
        if (!asset) return;
        
        const coinId = asset.id;
        const msg = payload.data;

        if (type === 'aggTrade') processAggTrade(coinId, msg);
        else if (type === 'depth20') processOrderbook(coinId, msg);
    });

    ws.on('error', (err) => { console.error("WS Error:", err); });
    ws.on('close', () => {
        console.log("WS Closed. Reconnecting...");
        setTimeout(initTitanStream, 3000);
    });
}

function processAggTrade(coinId, trade) {
    const price = parseFloat(trade.p);
    const qty = parseFloat(trade.q);
    const isMarketSell = trade.m;
    const tracker = orderFlowTracker[coinId];

    currentPrices[coinId] = price;

    const delta = isMarketSell ? -qty : qty;
    tracker.cvd += delta;
    
    const now = Date.now();
    if (now - tracker.lastUpdate > 1000) {
        tracker.deltaVelocity = tracker.cvd - tracker.lastCVD;
        tracker.lastCVD = tracker.cvd;
        tracker.lastUpdate = now;
    }

    tracker.absorptionBuffer.push({ qty, price, time: now, side: isMarketSell ? 'SELL' : 'BUY' });
    tracker.absorptionBuffer = tracker.absorptionBuffer.filter(t => now - t.time < 5000);

    if (price > tracker.htfHigh && tracker.htfHigh > 0) tracker.sweepSide = 'SHORT';
    else if (price < tracker.htfLow && tracker.htfLow > 0) tracker.sweepSide = 'LONG';
    else tracker.sweepSide = null;

    scoringEngine(coinId, price);

    if (activeMasterSignals[coinId]) {
        checkMasterExecution(coinId, price);
    }
}

function processOrderbook(coinId, depth) {
    const tracker = orderFlowTracker[coinId];
    const bids = depth.b.slice(0, 10).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    const asks = depth.a.slice(0, 10).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    tracker.topBids = bids; 
    tracker.topAsks = asks;
    tracker.imbalance = bids / asks;
}

async function scoringEngine(coinId, price) {
    const tracker = orderFlowTracker[coinId];
    
    let score = 0;
    let reasons = [];

    // 1. SMC: Снятие ликвидности
    if (tracker.sweepSide) { 
        score += 35; 
        reasons.push("LIQUIDITY_SWEEP"); 
    }
    
    // 2. Поглощение (Absorption)
    const clusterVol = tracker.absorptionBuffer.reduce((a, b) => a + b.qty, 0);
    const pRange = Math.max(...tracker.absorptionBuffer.map(t => t.price)) - Math.min(...tracker.absorptionBuffer.map(t => t.price));
    if (clusterVol > 0 && pRange < price * 0.0002) { 
        score += 30; 
        reasons.push("ABSORPTION"); 
    }

    // 3. Моментум дельты (подтверждение разворота)
    if ((tracker.deltaVelocity > 0 && tracker.sweepSide === 'LONG') || (tracker.deltaVelocity < 0 && tracker.sweepSide === 'SHORT')) {
        score += 20; 
        reasons.push("DELTA_MOMENTUM");
    }

    // 4. Дисбаланс стакана (L2)
    if ((tracker.imbalance > 1.8 && tracker.sweepSide === 'LONG') || (tracker.imbalance < 0.5 && tracker.sweepSide === 'SHORT')) {
        score += 15; 
        reasons.push("L2_IMBALANCE");
    }

    // Обновляем состояние для Watchlist
    tracker.currentScore = score;
    tracker.scoreDetails = reasons;

    // Если сигнала еще нет, но Score высокий - создаем сигнал
    if (score >= 75 && tracker.sweepSide && !activeMasterSignals[coinId]) {
        const side = tracker.sweepSide;
        await createMasterSignal(coinId, price, side, score, reasons.join(" | "));
        tracker.sweepSide = null;
    }
}

async function createMasterSignal(coinId, entry, side, score, reason) {
    const slDist = entry * 0.0055;
    const signal = new MasterSignal({
        coinId, pair: `${coinId}/USDT`, type: `🏦 ${coinId} ${side}`,
        entry, sl: side === 'LONG' ? entry - slDist : entry + slDist,
        tp: side === 'LONG' ? entry + slDist * 2.2 : entry - slDist * 2.2,
        size: 50, confidence: score, grade: 'A+', 
        timeLabel: new Date().toLocaleTimeString('ru-RU'),
        reason, score
    });
    await signal.save();
    activeMasterSignals[coinId] = signal.toObject();
    broadcastHackerLog(`🎯 MASTER ENTRY: ${coinId} ${side} (Score: ${score})`, 'ENTRY');
    sendGlobalPush(coinId, side, score);
}

function checkMasterExecution(coinId, price) {
    const sig = activeMasterSignals[coinId];
    const isLong = sig.type.includes('LONG');
    if (isLong) {
        if (price >= sig.tp) finalizeMasterTrade(coinId, "SUCCESS", sig.tp);
        else if (price <= sig.sl) finalizeMasterTrade(coinId, "FAILED", sig.sl);
    } else {
        if (price <= sig.tp) finalizeMasterTrade(coinId, "SUCCESS", sig.tp);
        else if (price >= sig.sl) finalizeMasterTrade(coinId, "FAILED", sig.sl);
    }
}

async function finalizeMasterTrade(coinId, result, exitPrice) {
    const sig = activeMasterSignals[coinId];
    if (!sig) return;

    const profitPerUnit = (exitPrice - sig.entry) * (sig.type.includes('LONG') ? 1 : -1);
    const premiumUsers = await User.find({ subscriptionStatus: "active" });

    const tradeDocs = premiumUsers.map(user => ({
        userId: user._id, pair: sig.pair, type: sig.type, entry: sig.entry,
        exit: exitPrice, sl: sig.sl, tp: sig.tp, result,
        profitCash: profitPerUnit * sig.size, rr: 2.2, grade: sig.grade, reason: sig.reason
    }));

    if (tradeDocs.length > 0) {
        await Trade.insertMany(tradeDocs);
        await User.updateMany({ subscriptionStatus: "active" }, { $inc: { balance: profitPerUnit * sig.size } });
    }

    await MasterSignal.deleteOne({ _id: sig._id });
    delete activeMasterSignals[coinId];
    syncWithDatabase();
}

// --- FULL STATISTICS CALCULATION (ДЛЯ INDEX.HTML) ---
async function getPersonalStats(userId) {
    const trades = await Trade.find({ userId }).sort({ timestamp: 1 });
    if (trades.length === 0) return { total: 0, winRate: 0, maxDrawdown: "0.0", avgRR: "0.0", streak: 0 };
    
    let balance = 1000, peak = 1000, mdd = 0, wins = 0, totalRR = 0, streak = 0;
    
    trades.forEach(t => {
        balance += t.profitCash;
        if (balance > peak) peak = balance;
        let dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
        if (dd > mdd) mdd = dd;
        if (t.result === "SUCCESS") { 
            wins++; 
            streak = streak < 0 ? 1 : streak + 1; 
        } else { 
            streak = streak > 0 ? -1 : streak - 1; 
        }
        totalRR += t.rr;
    });

    return {
        total: trades.length,
        winRate: Math.round((wins / trades.length) * 100),
        maxDrawdown: mdd.toFixed(1),
        avgRR: (totalRR / trades.length).toFixed(1),
        streak
    };
}

async function syncWithDatabase() {
    try {
        const dbActive = await MasterSignal.find();
        activeMasterSignals = {};
        dbActive.forEach(sig => {
            activeMasterSignals[sig.coinId] = sig.toObject();
        });
        tradeHistory = await Trade.find().sort({ timestamp: -1 }).limit(20);
    } catch (e) { console.error("Sync Error:", e); }
}

// --- API ROUTES (СОХРАНЕНО ПОЛНОСТЬЮ) ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        await new User({ email: req.body.email, password: hash }).save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Email already exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ id: user._id }, CONFIG.JWT_SECRET), email: user.email });
    } else res.status(401).json({ error: "Invalid credentials" });
});

app.get('/api/data', async (req, res) => {
    let isPrem = false; 
    let userId = null;
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], CONFIG.JWT_SECRET);
            userId = decoded.id;
            const user = await User.findById(userId);
            isPrem = user && user.subscriptionStatus === 'active';
        } catch (e) {}
    }

    const statsData = isPrem ? await getPersonalStats(userId) : { total: 0, winRate: 0 };
    const history = isPrem ? await Trade.find({ userId }).sort({ timestamp: -1 }).limit(15) : [];

    // Генерируем Watchlist для фронтенда (ТОП-5 монет по Score)
    const watchlist = Object.keys(orderFlowTracker)
        .map(id => ({
            id,
            score: orderFlowTracker[id].currentScore,
            reasons: orderFlowTracker[id].scoreDetails
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? Object.values(activeMasterSignals) : [], 
        tradeHistory: history, 
        stats: statsData, 
        premium: isPrem, 
        orderFlow: orderFlowTracker,
        watchlist: watchlist // Тот самый список ожидания
    });
});

app.post('/api/activate', async (req, res) => {
    try {
        const { token, codeStr } = req.body;
        const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (codeDoc) {
            const exp = new Date(); exp.setDate(exp.getDate() + codeDoc.days);
            await User.findByIdAndUpdate(decoded.id, { subscriptionStatus: "active", subscriptionExpires: exp });
            codeDoc.isUsed = true; 
            await codeDoc.save();
            res.json({ message: "Activated!" });
        } else res.status(404).json({ error: "Invalid or used code" });
    } catch (e) { res.status(401).send(); }
});

async function sendGlobalPush(coinId, side, score) {
    try {
        const subs = await PushSubscription.find();
        const payload = JSON.stringify({ 
            title: `TITAN FLOW: ${coinId}`, 
            body: `Master Signal ${side} [Score: ${score}]` 
        });
        subs.forEach(s => webpush.sendNotification(s.subscription, payload).catch(() => {}));
    } catch (err) {}
}

async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${asset.symbol.toUpperCase()}&interval=1h&limit=24`);
            orderFlowTracker[asset.id].htfHigh = Math.max(...res.data.map(c => parseFloat(c[2])));
            orderFlowTracker[asset.id].htfLow = Math.min(...res.data.map(c => parseFloat(c[3])));
        } catch (e) {}
    }
}

// --- INITIALIZE ---
initTitanStream();
updateHtfLevels();
setInterval(updateHtfLevels, 3600000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> TITAN FLOW MASTER v8.8 (GOLD) READY <<< `);
    console.log(`=========================================`);
});