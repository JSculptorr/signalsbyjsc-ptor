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
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

require('events').EventEmitter.defaultMaxListeners = 100;

// --- CONFIGURATION (DIGITAL FORTRESS v9.9 FLASH IMMORTAL) ---
const CONFIG = {
    API_KEY_GEMINI: process.env.API_KEY_GEMINI || "AIzaSyCD2KQA0BuPP0YJbKzpclrD-wGKjrKoscU",
    JWT_SECRET: process.env.JWT_SECRET || "jsc-secret-key-unique-2026",
    MONGO_URI: process.env.MONGO_URI || "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "jsc_ultra_secure_key_32_chars_!!",
    ALGORITHM: 'aes-256-cbc',
    VAPID_PUBLIC: process.env.VAPID_PUBLIC || "BO9C6q4TYaPHwA9_J-lNlqVk4IzPo44_96Mr2TjOXnDMp7GvxtTNXwlLEH6wj2jhRe_LOBjKGns1Hjc13oxTJFM",
    VAPID_PRIVATE: process.env.VAPID_PRIVATE || "YDw21D-BLvlwsawyHi59tqLoG4oCqnK7X96ND0z04W8"
};

// --- ИНИЦИАЛИЗАЦИЯ ИИ (FLASH МОДЕЛЬ - ВЫСОКИЙ ЛИМИТ) ---
const genAI = new GoogleGenerativeAI(CONFIG.API_KEY_GEMINI);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- СИСТЕМНЫЕ ПЕРЕМЕННЫЕ (LIMIT PROTECTION) ---
let aiQueue = 0;      
let aiCallsLastMinute = 0;
const MAX_AI_CALLS_PER_MIN = 12; 
const MAX_ACTIVE_SIGNALS = 3; 
const SYSTEM_DAILY_LOSS_LIMIT = 300; 

// Сброс счетчика вызовов (с логом в консоль для контроля)
setInterval(() => { 
    if (aiCallsLastMinute > 0) {
        console.log(`🧹 [System]: Resetting AI rate limits. Calls handled: ${aiCallsLastMinute}`);
        aiCallsLastMinute = 0; 
    }
}, 60000);

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

webpush.setVapidDetails('mailto:support@jsculptor.com', CONFIG.VAPID_PUBLIC, CONFIG.VAPID_PRIVATE);

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const connectDB = async () => {
    try {
        await mongoose.connect(CONFIG.MONGO_URI);
        console.log("✅ [NEURAL TITAN]: Fortress Engine v9.9 Digital Online (IMMORTAL FLASH)");
        syncWithDatabase();
    } catch (err) { 
        console.error("❌ DB Connection Error:", err);
        setTimeout(connectDB, 5000); 
    }
};
connectDB();

// --- DATA MODELS (СОХРАНЕНЫ ПОЛНОСТЬЮ) ---
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
    reason: String, score: Number, reasoning_detailed: String,
    timestamp: { type: Date, default: Date.now }
}));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    pair: String, type: String, entry: Number, exit: Number, sl: Number, tp: Number,
    result: String, profitCash: Number, rr: Number, grade: String, reason: String,
    ai_confidence: Number, ai_reasoning: String,
    timestamp: { type: Date, default: Date.now }
}));

// --- РАСШИРЕННЫЙ СПИСОК МОНЕТ (26 АКТИВОВ) ---
const ASSETS = [
    { id: 'BTC', symbol: 'BTCUSDT' }, { id: 'ETH', symbol: 'ETHUSDT' },
    { id: 'SOL', symbol: 'SOLUSDT' }, { id: 'BNB', symbol: 'BNBUSDT' },
    { id: 'XRP', symbol: 'XRPUSDT' }, { id: 'ADA', symbol: 'ADAUSDT' },
    { id: 'DOGE', symbol: 'DOGEUSDT' }, { id: 'MATIC', symbol: 'MATICUSDT' },
    { id: 'DOT', symbol: 'DOTUSDT' }, { id: 'LINK', symbol: 'LINKUSDT' },
    { id: 'TRX', symbol: 'TRXUSDT' }, { id: 'AVAX', symbol: 'AVAXUSDT' },
    { id: 'LTC', symbol: 'LTCUSDT' }, { id: 'BCH', symbol: 'BCHUSDT' },
    { id: 'SHIB', symbol: 'SHIBUSDT' }, { id: 'ATOM', symbol: 'ATOMUSDT' },
    { id: 'XLM', symbol: 'XLMUSDT' }, { id: 'NEAR', symbol: 'NEARUSDT' },
    { id: 'UNI', symbol: 'UNIUSDT' }, { id: 'APT', symbol: 'APTUSDT' },
    { id: 'ARB', symbol: 'ARBUSDT' }, { id: 'OP', symbol: 'OPUSDT' },
    { id: 'FIL', symbol: 'FILUSDT' }, { id: 'LDO', symbol: 'LDOUSDT' },
    { id: 'SUI', symbol: 'SUIUSDT' }, { id: 'GOLD', symbol: 'XAUUSDT' }
];

let currentPrices = {};
let activeMasterSignals = {}; 
let orderFlowTracker = {};
let lastAiAnalysis = {}; 

ASSETS.forEach(a => {
    orderFlowTracker[a.id] = {
        cvd: 0, lastCVD: 0, deltaVelocity: 0,
        absorptionBuffer: [], imbalance: 0,
        htfHigh: 0, htfLow: 0, sweepSide: null,
        currentScore: 0, scoreDetails: [],
        lastUpdate: Date.now()
    };
    currentPrices[a.id] = 0;
    lastAiAnalysis[a.id] = 0;
});

function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', AI: '🧠', ENTRY: '🎯', ALERT: '🚨' };
    io.emit('hacker_log', `[${time}] ${icons[type] || ''} ${msg}`);
}

async function fetchCandleData(symbol, interval = '15m', limit = 40) {
    try {
        const binanceSymbol = symbol.toUpperCase().replace('/', '');
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
        const res = await axios.get(url);
        return res.data.map(c => [
            new Date(c[0]).toLocaleTimeString('en-GB'),
            parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4])
        ]);
    } catch (e) { return null; }
}

async function checkSystemRisk() {
    const today = new Date(); today.setHours(0,0,0,0);
    const trades = await Trade.find({ timestamp: { $gte: today } });
    const systemPnL = trades.reduce((acc, t) => acc + t.profitCash, 0);
    return systemPnL > -SYSTEM_DAILY_LOSS_LIMIT;
}

// --- BINANCE WS ENGINE (IMMORTAL EDITION С HEARTBEAT) ---
function initTitanStream() {
    const streamNames = ASSETS.map(a => `${a.symbol.toLowerCase()}@aggTrade`).join('/') + '/' + 
                        ASSETS.map(a => `${a.symbol.toLowerCase()}@depth20@100ms`).join('/');
    
    const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamNames}`);

    let pingTimeout;
    function heartbeat() {
        clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => {
            console.log("⚠️ [Binance WS]: Heartbeat lost. Forcing Reconnect...");
            ws.terminate(); // Это вызовет событие 'close' и перезапуск
        }, 35000); 
    }

    ws.on('open', () => { 
        console.log("📡 [Binance WS]: Connected to Market Flow. Heartbeat active.");
        heartbeat();
    });

    ws.on('ping', () => {
        heartbeat();
        ws.pong();
    });

    ws.on('message', (data) => {
        try {
            heartbeat();
            const payload = JSON.parse(data);
            const stream = payload.stream;
            if (!stream) return;

            const asset = ASSETS.find(a => stream.startsWith(a.symbol.toLowerCase()));
            if (!asset) return;
            
            const coinId = asset.id;
            if (stream.includes('@aggTrade')) processAggTrade(coinId, payload.data);
            else if (stream.includes('@depth20')) processOrderbook(coinId, payload.data);
        } catch (e) {}
    });

    ws.on('error', (err) => {
        console.error("❌ [Binance WS] Connection Error:", err.message);
    });

    ws.on('close', () => {
        clearTimeout(pingTimeout);
        console.log("⚠️ [Binance WS]: Stream Closed. Rebooting in 5s...");
        setTimeout(initTitanStream, 5000);
    });
}

function processAggTrade(coinId, trade) {
    const price = parseFloat(trade.p);
    const tracker = orderFlowTracker[coinId];
    currentPrices[coinId] = price;
    
    const qty = parseFloat(trade.q);
    const delta = trade.m ? -qty : qty;
    tracker.cvd += delta;
    
    const now = Date.now();
    if (now - tracker.lastUpdate > 1000) {
        tracker.deltaVelocity = tracker.cvd - tracker.lastCVD;
        tracker.lastCVD = tracker.cvd;
        tracker.lastUpdate = now;
    }

    tracker.absorptionBuffer.push({ qty, price, time: now });
    tracker.absorptionBuffer = tracker.absorptionBuffer.filter(t => now - t.time < 5000);

    if (price > tracker.htfHigh && tracker.htfHigh > 0) tracker.sweepSide = 'SHORT';
    else if (price < tracker.htfLow && tracker.htfLow > 0) tracker.sweepSide = 'LONG';
    else tracker.sweepSide = null;

    updateTechnicalScore(coinId, price);
    if (activeMasterSignals[coinId]) checkMasterExecution(coinId, price);
}

function processOrderbook(coinId, depth) {
    const tracker = orderFlowTracker[coinId];
    const bids = depth.b.slice(0, 5).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    const asks = depth.a.slice(0, 5).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    tracker.imbalance = asks > 0 ? bids / asks : 1;
}

// --- УЛУЧШЕННЫЙ РАСЧЕТ ОЧКОВ (ВЫСОКАЯ ЧУВСТВИТЕЛЬНОСТЬ) ---
function updateTechnicalScore(coinId, price) {
    const tracker = orderFlowTracker[coinId];
    let score = 0; let reasons = [];

    // 1. LIQUIDITY SWEEP
    if (tracker.sweepSide) { score += 35; reasons.push("LIQUIDITY_SWEEP"); }

    // 2. ABSORPTION ($150,000 threshold - institutional level)
    const clusterVolUSDT = tracker.absorptionBuffer.reduce((a, b) => a + (b.qty * b.price), 0);
    if (clusterVolUSDT > 150000) { score += 25; reasons.push("INST_VOLUME"); }

    // 3. IMBALANCE (Sense: 1.6)
    if (tracker.imbalance > 1.6 || tracker.imbalance < 0.6) { score += 15; reasons.push("ORDER_FLOW"); }

    // 4. MOMENTUM PULSE
    if (Math.abs(tracker.deltaVelocity) > 40) { score += 10; reasons.push("VELOCITY"); }

    tracker.currentScore = score;
    tracker.scoreDetails = reasons;
}

// --- ЦЕНТРАЛЬНЫЙ СКАНЕР (FLASH OPTIMIZED) ---
async function runMarketScan() {
    if (aiCallsLastMinute >= MAX_AI_CALLS_PER_MIN) return;

    const candidates = Object.keys(orderFlowTracker)
        .filter(id => orderFlowTracker[id].currentScore >= 25 && (Date.now() - lastAiAnalysis[id] > 240000))
        .sort((a, b) => orderFlowTracker[b].currentScore - orderFlowTracker[a].currentScore)
        .slice(0, 4);

    if (candidates.length === 0) return;

    aiCallsLastMinute++;
    broadcastHackerLog(`[AI Scanner]: Анализ данных: ${candidates.join(', ')}`, 'AI');

    let batchData = [];
    for (const id of candidates) {
        const candles = await fetchCandleData(id, '15m', 35);
        if (candles) batchData.push({ id, price: currentPrices[id], candles });
    }

    if (batchData.length === 0) return;

    try {
        const prompt = `ACT AS SMC PRO. Analyze OHLCV candle arrays.
        Identify: Market Trend, Order Blocks, Fair Value Gaps.
        Data: ${JSON.stringify(batchData)}
        
        OUTPUT ONLY JSON ARRAY:
        [{"id": "BTC", "action": "EXECUTE_LONG", "reason": "BOS detected", "confidence": 85, "tp": 0, "sl": 0}, ...]
        Use "WATCH" if no clear setup.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const verdicts = JSON.parse(cleanJson);

        for (const v of verdicts) {
            lastAiAnalysis[v.id] = Date.now();
            if (v.action.includes('EXECUTE') && v.confidence >= 80 && !activeMasterSignals[v.id]) {
                const side = v.action.includes('LONG') ? 'LONG' : 'SHORT';
                
                let tp = v.tp, sl = v.sl;
                if (tp === 0 || sl === 0) {
                    const offset = currentPrices[v.id] * 0.01;
                    tp = side === 'LONG' ? currentPrices[v.id] + (offset * 2) : currentPrices[v.id] - (offset * 2);
                    sl = side === 'LONG' ? currentPrices[v.id] - offset : currentPrices[v.id] + offset;
                }

                await createMasterSignal(v.id, currentPrices[v.id], side, v.confidence, v.reason, tp, sl);
            }
        }
    } catch (e) {}
}

setInterval(runMarketScan, 30000);

async function createMasterSignal(coinId, entry, side, score, reason, tp, sl) {
    if (Object.keys(activeMasterSignals).length >= MAX_ACTIVE_SIGNALS) return;
    try {
        const signal = new MasterSignal({
            coinId, pair: `${coinId}/USDT`, type: `🏦 ${coinId} ${side}`,
            entry, sl, tp, size: 50, confidence: score, grade: 'Fortress v9.9 Digital', 
            timeLabel: new Date().toLocaleTimeString('ru-RU'),
            reason: `[AI]: ${reason}`, reasoning_detailed: reason, score
        });
        await signal.save();
        activeMasterSignals[coinId] = signal.toObject();
        broadcastHackerLog(`🎯 NEURAL ENTRY: ${coinId} ${side}`, 'ENTRY');
        sendGlobalPush(coinId, side, score);
    } catch (e) {}
}

// --- УПРАВЛЕНИЕ ТОРГОВЛЕЙ (СОХРАНЕНО ПОЛНОСТЬЮ) ---
function checkMasterExecution(coinId, price) {
    const sig = activeMasterSignals[coinId];
    if (!sig) return;
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
    const isLong = sig.type.includes('LONG');
    const profitPerUnit = (exitPrice - sig.entry) * (isLong ? 1 : -1);
    
    const premiumUsers = await User.find({ subscriptionStatus: "active" });
    const tradeDocs = premiumUsers.map(user => ({
        userId: user._id, pair: sig.pair, type: sig.type, entry: sig.entry,
        exit: exitPrice, sl: sig.sl, tp: sig.tp, result,
        profitCash: profitPerUnit * sig.size, rr: 2.2, grade: sig.grade, 
        reason: sig.reason, ai_confidence: sig.confidence, ai_reasoning: sig.reasoning_detailed
    }));
    
    if (tradeDocs.length > 0) {
        await Trade.insertMany(tradeDocs);
        await User.updateMany({ subscriptionStatus: "active" }, { $inc: { balance: profitPerUnit * sig.size } });
    }
    
    await MasterSignal.deleteOne({ _id: sig._id });
    delete activeMasterSignals[coinId];
    broadcastHackerLog(`🏁 ${coinId} Закрыт: ${result}`, 'INFO');
    syncWithDatabase();
}

async function getPersonalStats(userId) {
    const trades = await Trade.find({ userId }).sort({ timestamp: 1 });
    if (trades.length === 0) return { total: 0, winRate: 0, maxDrawdown: "0.0", avgRR: "0.0", streak: 0 };
    let balance = 1000, peak = 1000, mdd = 0, wins = 0, totalRR = 0, streak = 0;
    trades.forEach(t => {
        balance += t.profitCash;
        if (balance > peak) peak = balance;
        let dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
        if (dd > mdd) mdd = dd;
        if (t.result === "SUCCESS") { wins++; streak = streak < 0 ? 1 : streak + 1; } 
        else { streak = streak > 0 ? -1 : streak - 1; }
        totalRR += t.rr;
    });
    return { total: trades.length, winRate: Math.round((wins / trades.length) * 100), maxDrawdown: mdd.toFixed(1), avgRR: (totalRR / trades.length).toFixed(1), streak };
}

async function syncWithDatabase() {
    try {
        const dbActive = await MasterSignal.find();
        activeMasterSignals = {};
        dbActive.forEach(sig => { activeMasterSignals[sig.coinId] = sig.toObject(); });
    } catch (e) {}
}

// --- API ROUTES (СОХРАНЕНЫ ПОЛНОСТЬЮ) ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        await new User({ email: req.body.email, password: hash }).save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    if (user && await bcrypt.compare(req.body.password, user.password)) {
        res.json({ token: jwt.sign({ id: user._id }, CONFIG.JWT_SECRET), email: user.email });
    } else res.status(401).send();
});

app.get('/api/data', async (req, res) => {
    let isPrem = false; let userId = null;
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
    const watchlist = Object.keys(orderFlowTracker)
        .map(id => ({ id, score: orderFlowTracker[id].currentScore, reasons: orderFlowTracker[id].scoreDetails }))
        .sort((a, b) => b.score - a.score).slice(0, 10);

    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? Object.values(activeMasterSignals) : [], 
        tradeHistory: isPrem ? await Trade.find({ userId }).sort({ timestamp: -1 }).limit(10) : [], 
        stats: statsData, 
        premium: isPrem, 
        orderFlow: orderFlowTracker,
        watchlist: watchlist
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
            codeDoc.isUsed = true; await codeDoc.save();
            syncWithDatabase();
            res.json({ message: "Activated!" });
        } else res.status(404).send();
    } catch (e) { res.status(401).send(); }
});

async function sendGlobalPush(coinId, side, score) {
    try {
        const subs = await PushSubscription.find();
        const payload = JSON.stringify({ title: `JSculptor v9.9: ${coinId}`, body: `Neural Verdict: ${side} (Score: ${score})` });
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

initTitanStream();
updateHtfLevels();
setInterval(updateHtfLevels, 3600000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> NEURAL TITAN v9.9 DIGITAL READY <<< `);
    console.log(`=========================================`);
});