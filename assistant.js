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

// --- CONFIGURATION (PRO-READY) ---
const CONFIG = {
    JWT_SECRET: process.env.JWT_SECRET || "jsc-secret-key-unique-2026",
    MONGO_URI: process.env.MONGO_URI || "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0",
    ENCRYPTION_KEY: "jsc_ultra_secure_key_32_chars_!!",
    ALGORITHM: 'aes-256-cbc',
    VAPID_PUBLIC: "BO9C6q4TYaPHwA9_J-lNlqVk4IzPo44_96Mr2TjOXnDMp7GvxtTNXwlLEH6wj2jhRe_LOBjKGns1Hjc13oxTJFM",
    VAPID_PRIVATE: "YDw21D-BLvlwsawyHi59tqLoG4oCqnK7X96ND0z04W8"
};

// --- INSTITUTIONAL ENCRYPTION SYSTEM (RETAINED) ---
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

// --- VAPID PUSH NOTIFICATIONS (RETAINED) ---
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
        console.log("✅ [TITAN FLOW]: Institutional Engine v8.5 Online");
        syncWithDatabase();
    } catch (err) { 
        console.error("❌ DB Connection Error:", err);
        setTimeout(connectDB, 5000); 
    }
};
connectDB();

// --- DATA MODELS (RETAINED & FIXED) ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }, 
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

const ActiveSignal = mongoose.model('ActiveSignal', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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

// --- GLOBAL ASSETS (24 COINS) ---
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
    { id: 'TIA', symbol: 'tiausdt' }, { id: 'INJ', symbol: 'injusdt' }
];

// --- TITAN FLOW STATE (MEMORY CACHE) ---
let currentPrices = {};
let activeSignals = {}; // Structure: { [coinId]: { [userId]: signalData } }
let stats = { total: 0, wins: 0, winRate: 0 };
let tradeHistory = [];

// Order Flow Tracker v8.5
let orderFlowTracker = {};
ASSETS.forEach(a => {
    orderFlowTracker[a.id] = {
        cvd: 0,
        lastCVD: 0,
        deltaVelocity: 0,
        absorptionBuffer: [], // Trades in last 5s
        topBids: 0,
        topAsks: 0,
        htfHigh: 0,
        htfLow: 0,
        imbalance: 0,
        lastUpdate: Date.now(),
        sweepSide: null
    };
    currentPrices[a.id] = 0;
    activeSignals[a.id] = {}; // Initialize nested user maps
});

function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', SWEEP: '🚨', ABSORPTION: '🧱', ENTRY: '🎯', DELTA: '📊', MOMENTUM: '⚡' };
    io.emit('hacker_log', `[${time}] ${icons[type] || ''} ${msg}`);
}

// --- BINANCE WS ENGINE (EVENT-DRIVEN & THROTTLED) ---
function initTitanStream() {
    const streams = ASSETS.map(a => `${a.symbol}@aggTrade`).join('/') + '/' + 
                    ASSETS.map(a => `${a.symbol}@depth20@100ms`).join('/');
    
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    ws.on('message', (data) => {
        const payload = JSON.parse(data);
        const [symbol, type] = payload.stream.split('@');
        const coinId = ASSETS.find(a => a.symbol === symbol).id;
        const msg = payload.data;

        if (type === 'aggTrade') processAggTrade(coinId, msg);
        else if (type === 'depth20') processOrderbook(coinId, msg);
    });

    ws.on('error', () => {});
    ws.on('close', () => setTimeout(initTitanStream, 3000));
}

// 1. IMPROVED ABSORPTION & DELTA MOMENTUM
function processAggTrade(coinId, trade) {
    const price = parseFloat(trade.p);
    const qty = parseFloat(trade.q);
    const isMarketSell = trade.m;
    const tracker = orderFlowTracker[coinId];

    currentPrices[coinId] = price;

    // A. Delta Momentum Calculation
    const delta = isMarketSell ? -qty : qty;
    tracker.cvd += delta;
    
    // Calculate Velocity every 1s
    const now = Date.now();
    if (now - tracker.lastUpdate > 1000) {
        tracker.deltaVelocity = tracker.cvd - tracker.lastCVD;
        tracker.lastCVD = tracker.cvd;
        tracker.lastUpdate = now;
    }

    // B. Absorption Cluster (5s Window)
    tracker.absorptionBuffer.push({ qty, price, time: now, side: isMarketSell ? 'SELL' : 'BUY' });
    tracker.absorptionBuffer = tracker.absorptionBuffer.filter(t => now - t.time < 5000);

    // C. HTF Sweep Detector
    if (price > tracker.htfHigh && tracker.htfHigh > 0) tracker.sweepSide = 'SHORT';
    else if (price < tracker.htfLow && tracker.htfLow > 0) tracker.sweepSide = 'LONG';
    else tracker.sweepSide = null;

    // Ядро расчёта сигналов
    scoringEngine(coinId, price);

    // Ведение активных сделок
    Object.keys(activeSignals[coinId]).forEach(userId => {
        checkTradeExecution(coinId, userId, price);
    });
}

// 2. WEIGHTED TOP-LEVEL IMBALANCE
function processOrderbook(coinId, depth) {
    const tracker = orderFlowTracker[coinId];
    // Берем только ТОП-10 уровней
    const bids = depth.b.slice(0, 10).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    const asks = depth.a.slice(0, 10).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    
    tracker.topBids = bids;
    tracker.topAsks = asks;
    tracker.imbalance = bids / asks;
}

// 3. TITAN SCORING SYSTEM (v8.5)
async function scoringEngine(coinId, price) {
    const tracker = orderFlowTracker[coinId];
    let score = 0;
    let reasons = [];

    // Factor 1: Liquidity Sweep (35 points)
    if (tracker.sweepSide) {
        score += 35;
        reasons.push("HTF_LIQUIDITY_SWEEP");
    }

    // Factor 2: Absorption Cluster (30 points)
    const clusterVol = tracker.absorptionBuffer.reduce((a, b) => a + b.qty, 0);
    const pRange = Math.max(...tracker.absorptionBuffer.map(t => t.price)) - Math.min(...tracker.absorptionBuffer.map(t => t.price));
    
    if (clusterVol > 0 && pRange < price * 0.0002) { // Высокий объем при зажатой цене
        score += 30;
        reasons.push("INSTITUTIONAL_ABSORPTION");
    }

    // Factor 3: Delta Velocity Flip (20 points)
    const isLongMomentum = tracker.deltaVelocity > 0 && tracker.sweepSide === 'LONG';
    const isShortMomentum = tracker.deltaVelocity < 0 && tracker.sweepSide === 'SHORT';
    if (isLongMomentum || isShortMomentum) {
        score += 20;
        reasons.push("DELTA_VELOCITY_FLIP");
    }

    // Factor 4: Top-Level Imbalance (15 points)
    if ((tracker.imbalance > 1.8 && tracker.sweepSide === 'LONG') || 
        (tracker.imbalance < 0.5 && tracker.sweepSide === 'SHORT')) {
        score += 15;
        reasons.push("L2_TOP_IMBALANCE");
    }

    // EXECUTION
    if (score >= 75) {
        const side = tracker.sweepSide;
        await createMultiUserSignal(coinId, price, side, score, reasons.join(" | "));
        tracker.sweepSide = null; // Prevent double firing
    }
}

async function createMultiUserSignal(coinId, entry, side, score, reason) {
    const premiumUsers = await User.find({ subscriptionStatus: "active" });
    const slDist = entry * 0.0055;
    const sl = side === 'LONG' ? entry - slDist : entry + slDist;
    const tp = side === 'LONG' ? entry + slDist * 2.2 : entry - slDist * 2.2;
    const timeLabel = new Date().toLocaleTimeString('ru-RU');

    for (const user of premiumUsers) {
        // Если у юзера нет активного сигнала по этой монете
        if (!activeSignals[coinId][user._id]) {
            const sig = new ActiveSignal({
                userId: user._id, coinId, pair: `${coinId}/USDT`,
                type: `🏦 ${coinId} ${side}`,
                entry, sl, tp, size: 2000 / entry, // Настройка под риск
                confidence: score, grade: 'A+', timeLabel, reason, score
            });
            await sig.save();
            activeSignals[coinId][user._id] = { ...sig._doc };
        }
    }

    broadcastHackerLog(`🎯 TITAN ENTRY: ${coinId} ${side} (Score: ${score})`, 'ENTRY');
}

// --- TRADE MANAGEMENT (PER USER) ---
function checkTradeExecution(coinId, userId, price) {
    const sig = activeSignals[coinId][userId];
    if (!sig) return;

    const isLong = sig.type.includes('LONG');
    if (isLong) {
        if (price >= sig.tp) finalizeUserTrade(coinId, userId, "SUCCESS", sig.tp);
        else if (price <= sig.sl) finalizeUserTrade(coinId, userId, "FAILED", sig.sl);
    } else {
        if (price <= sig.tp) finalizeUserTrade(coinId, userId, "SUCCESS", sig.tp);
        else if (price >= sig.sl) finalizeUserTrade(coinId, userId, "FAILED", sig.sl);
    }
}

async function finalizeUserTrade(coinId, userId, result, exitPrice) {
    const sig = activeSignals[coinId][userId];
    const profit = (exitPrice - sig.entry) * sig.size;
    
    await new Trade({
        userId, pair: sig.pair, type: sig.type, entry: sig.entry, exit: exitPrice,
        sl: sig.sl, tp: sig.tp, result, profitCash: profit, rr: 2.2,
        grade: sig.grade, reason: sig.reason
    }).save();

    await ActiveSignal.deleteOne({ _id: sig._id });
    await User.findByIdAndUpdate(userId, { $inc: { balance: profit } });
    
    delete activeSignals[coinId][userId];
    await syncWithDatabase();
}

// --- HTF SYNC ---
async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${asset.symbol.toUpperCase()}&interval=1h&limit=24`);
            const tracker = orderFlowTracker[asset.id];
            tracker.htfHigh = Math.max(...res.data.map(c => parseFloat(c[2])));
            tracker.htfLow = Math.min(...res.data.map(c => parseFloat(c[3])));
        } catch (e) {}
    }
}

// --- STANDARD CORE FUNCTIONS (RETAINED) ---
async function syncWithDatabase() {
    const dbActive = await ActiveSignal.find();
    dbActive.forEach(sig => { 
        if (!activeSignals[sig.coinId]) activeSignals[sig.coinId] = {};
        activeSignals[sig.coinId][sig.userId] = { ...sig._doc }; 
    });
    tradeHistory = await Trade.find().sort({ timestamp: -1 }).limit(20);
}

// --- API ROUTES ---
app.post('/api/auth/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    await new User({ email: req.body.email, password: hash }).save();
    res.json({ message: "Success" });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ id: user._id }, CONFIG.JWT_SECRET), email: user.email });
    } else res.status(401).send();
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

    // Собираем сигналы только для текущего юзера
    let userSignals = [];
    if (isPrem && userId) {
        Object.keys(activeSignals).forEach(coinId => {
            if (activeSignals[coinId][userId]) userSignals.push(activeSignals[coinId][userId]);
        });
    }

    res.json({ 
        prices: currentPrices, 
        activeSignals: userSignals, 
        tradeHistory, stats, premium: isPrem, 
        orderFlow: orderFlowTracker 
    });
});

app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
    if (codeDoc) {
        const exp = new Date(); exp.setDate(exp.getDate() + codeDoc.days);
        await User.findByIdAndUpdate(decoded.id, { subscriptionStatus: "active", subscriptionExpires: exp });
        codeDoc.isUsed = true; await codeDoc.save();
        res.json({ message: "Activated!" });
    } else res.status(404).send();
});

// --- INITIALIZE ---
initTitanStream();
updateHtfLevels();
setInterval(updateHtfLevels, 3600000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`>>> TITAN FLOW v8.5 READY <<<`));