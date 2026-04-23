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
const puppeteer = require('puppeteer'); // ГЛАЗА УСТАНОВЛЕНЫ
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// Убираем предупреждение MaxListenersExceededWarning
require('events').EventEmitter.defaultMaxListeners = 100;

// --- CONFIGURATION (PRO-READY) ---
const CONFIG = {
    API_KEY_GEMINI: "AIzaSyCD2KQA0BuPP0YJbKzpclrD-wGKjrKoscU",
    JWT_SECRET: process.env.JWT_SECRET || "jsc-secret-key-unique-2026",
    MONGO_URI: process.env.MONGO_URI || "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0",
    ENCRYPTION_KEY: "jsc_ultra_secure_key_32_chars_!!",
    ALGORITHM: 'aes-256-cbc',
    VAPID_PUBLIC: "BO9C6q4TYaPHwA9_J-lNlqVk4IzPo44_96Mr2TjOXnDMp7GvxtTNXwlLEH6wj2jhRe_LOBjKGns1Hjc13oxTJFM",
    VAPID_PRIVATE: "YDw21D-BLvlwsawyHi59tqLoG4oCqnK7X96ND0z04W8"
};

// --- ИНИЦИАЛИЗАЦИЯ ИИ (GEMINI 1.5 FLASH) ---
const genAI = new GoogleGenerativeAI(CONFIG.API_KEY_GEMINI);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- INSTITUTIONAL ENCRYPTION SYSTEM ---
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

// --- VAPID PUSH NOTIFICATIONS ---
webpush.setVapidDetails('mailto:support@jsculptor.com', CONFIG.VAPID_PUBLIC, CONFIG.VAPID_PRIVATE);

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- MONGODB CLUSTER CONNECTION (С ПРОВЕРКОЙ) ---
const connectDB = async () => {
    try {
        await mongoose.connect(CONFIG.MONGO_URI, { 
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000 
        });
        console.log("✅ [NEURAL TITAN]: AI-Agent Master Engine v9.5 Vision Online");
        syncWithDatabase();
    } catch (err) { 
        console.error("❌ DB Connection Error (Check Billing/Network):", err);
        setTimeout(connectDB, 5000); 
    }
};
connectDB();

// --- DATA MODELS ---
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

// --- GLOBAL ASSETS ---
const ASSETS = [
    { id: 'BTC', symbol: 'btcusdt' }, { id: 'ETH', symbol: 'ethusdt' },
    { id: 'SOL', symbol: 'solusdt' }, { id: 'LINK', symbol: 'linkusdt' },
    { id: 'BNB', symbol: 'bnbusdt' }, { id: 'DOGE', symbol: 'dogeusdt' },
    { id: 'GOLD', symbol: 'xauusdt' }
];

// --- MASTER STATE ---
let currentPrices = {};
let activeMasterSignals = {}; 
let tradeHistory = [];
let orderFlowTracker = {};
let lastAiAnalysis = {}; 

ASSETS.forEach(a => {
    orderFlowTracker[a.id] = {
        cvd: 0, lastCVD: 0, deltaVelocity: 0,
        absorptionBuffer: [], topBids: 0, topAsks: 0,
        htfHigh: 0, htfLow: 0, imbalance: 0,
        lastUpdate: Date.now(), sweepSide: null,
        currentScore: 0, 
        scoreDetails: []
    };
    currentPrices[a.id] = 0;
    lastAiAnalysis[a.id] = 0;
});

function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', AI: '🧠', ENTRY: '🎯', ALERT: '🚨' };
    io.emit('hacker_log', `[${time}] ${icons[type] || ''} ${msg}`);
}

// --- VISION MODULE: CAPTURE SCREENSHOT ---
async function captureMarketScreenshot(coinId) {
    try {
        const browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        
        const symbol = coinId === 'GOLD' ? 'XAUUSD' : coinId + 'USDT';
        // Используем график TradingView (виджет)
        const url = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`;
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        // Ждем отрисовки графика
        await new Promise(r => setTimeout(r, 5000)); 
        
        const screenshot = await page.screenshot({ encoding: "base64" });
        await browser.close();
        return screenshot;
    } catch (e) {
        console.error("Vision Capture Error:", e);
        return null;
    }
}

// --- BINANCE WS ENGINE ---
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
        if (type === 'aggTrade') processAggTrade(coinId, payload.data);
        else if (type === 'depth20') processOrderbook(coinId, payload.data);
    });

    ws.on('close', () => setTimeout(initTitanStream, 3000));
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

    updateTechnicalScore(coinId, price);

    // Триггер ИИ v9.5 (Зрение + Логика)
    if ((tracker.currentScore >= 45 || tracker.sweepSide) && (now - lastAiAnalysis[coinId] > 300000)) {
        getAiMarketVerdict(coinId, price);
        lastAiAnalysis[coinId] = now;
    }

    if (activeMasterSignals[coinId]) {
        checkMasterExecution(coinId, price);
    }
}

function processOrderbook(coinId, depth) {
    const tracker = orderFlowTracker[coinId];
    const bids = depth.b.slice(0, 10).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    const asks = depth.a.slice(0, 10).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    tracker.topBids = bids; tracker.topAsks = asks;
    tracker.imbalance = asks > 0 ? bids / asks : 1;
}

function updateTechnicalScore(coinId, price) {
    const tracker = orderFlowTracker[coinId];
    let score = 0; let reasons = [];
    if (tracker.sweepSide) { score += 35; reasons.push("LIQUIDITY_SWEEP"); }
    const clusterVol = tracker.absorptionBuffer.reduce((a, b) => a + b.qty, 0);
    if (clusterVol > (coinId === 'GOLD' ? 10 : 150)) { score += 25; reasons.push("ABSORPTION"); }
    if (tracker.imbalance > 1.7 || tracker.imbalance < 0.6) { score += 10; reasons.push("L2_FLOW"); }
    tracker.currentScore = score;
    tracker.scoreDetails = reasons;
}

// --- ЦЕНТРАЛЬНЫЙ МОЗГ: AI AGENT VISION ENGINE v9.5 ---
async function getAiMarketVerdict(coinId, price) {
    const tracker = orderFlowTracker[coinId];
    broadcastHackerLog(`[Vision]: Инициализирую захват графика ${coinId}...`, 'AI');
    
    const screenshotBase64 = await captureMarketScreenshot(coinId);
    const absVol = tracker.absorptionBuffer.reduce((a, b) => a + b.qty, 0);

    const contextText = `
        Asset: ${coinId}, Price: ${price}
        HTF Range: [${tracker.htfLow} - ${tracker.htfHigh}]
        Status: ${tracker.sweepSide || 'Range'}
        Delta Velocity: ${tracker.deltaVelocity.toFixed(2)}, Imbalance: ${tracker.imbalance.toFixed(2)}
        Volume 5s: ${absVol.toFixed(2)}
    `;

    try {
        const prompt = `Ты — профессиональный институциональный трейдер (Smart Money, Order Flow).
        Анализируй рынок по шагам:
        1. VISUAL: Посмотри на график (ИЗОБРАЖЕНИЕ). Найди структуру, sweep, паттерны.
        2. CONTEXT: Используй данные: ${contextText}.
        3. DECISION: Если график и данные подтверждают вход (Confidence > 75%), дай EXECUTE.
        
        Отвечай СТРОГО:
        REASONING: (твоя логика кратко)
        ACTION: (EXECUTE_LONG, EXECUTE_SHORT, или WATCH)
        CONFIDENCE: (0-100)
        TP_SL: {"tp": число, "sl": число}`;

        let aiParts = [{ text: prompt }];
        if (screenshotBase64) {
            aiParts.push({
                inlineData: { data: screenshotBase64, mimeType: "image/png" }
            });
        }

        const result = await model.generateContent(aiParts);
        const response = await result.response;
        const text = response.text();

        // ИСПРАВЛЕННЫЙ СИНТАКСИС (БЕЗ ОШИБОК)
        const reasoning = text.match(/REASONING: (.*)/)?.[1] || "Анализ структуры завершен.";
        const action = text.match(/ACTION: (.*)/)?.[1] || "WATCH";
        const confidence = parseInt(text.match(/CONFIDENCE: (\d+)/)?.[1]) || 0;

        broadcastHackerLog(`[Gemini AI]: ${reasoning}`, 'AI');

        if (action.includes('EXECUTE') && confidence >= 75 && !activeMasterSignals[coinId]) {
            const side = action.includes('LONG') ? 'LONG' : 'SHORT';
            let tp, sl;
            try { 
                const jsonMatch = text.match(/TP_SL: (\{.*\})/);
                const json = JSON.parse(jsonMatch[1]);
                tp = json.tp; sl = json.sl;
            } catch(e) {
                const dist = price * 0.007;
                tp = side === 'LONG' ? price + dist * 2.5 : price - dist * 2.5;
                sl = side === 'LONG' ? price - dist : price + dist;
            }
            await createMasterSignal(coinId, price, side, confidence, reasoning, tp, sl);
        }
    } catch (e) { console.error("AI Decision Error:", e); }
}

async function createMasterSignal(coinId, entry, side, score, reason, tp, sl) {
    try {
        const signal = new MasterSignal({
            coinId, pair: `${coinId}/USDT`, type: `🏦 ${coinId} ${side}`,
            entry, sl, tp, size: 50, confidence: score, grade: 'Neural-v9.5', 
            timeLabel: new Date().toLocaleTimeString('ru-RU'),
            reason: `[AI Verdict]: ${reason}`, score
        });
        await signal.save();
        activeMasterSignals[coinId] = signal.toObject();
        broadcastHackerLog(`🎯 NEURAL ENTRY: ${coinId} ${side} (Conf: ${score}%)`, 'ENTRY');
        sendGlobalPush(coinId, side, score);
    } catch (dbErr) {
        console.error("❌ Database Save Error:", dbErr);
        broadcastHackerLog("Ошибка базы данных: Сигнал не сохранен", "ALERT");
    }
}

// --- ФУНКЦИИ УПРАВЛЕНИЯ ТОРГОВЛЕЙ (СОХРАНЕНЫ ПОЛНОСТЬЮ) ---
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
        profitCash: profitPerUnit * sig.size, rr: 2.2, grade: sig.grade, reason: sig.reason
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
        tradeHistory = await Trade.find().sort({ timestamp: -1 }).limit(20);
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
        .sort((a, b) => b.score - a.score).slice(0, 5);
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
            res.json({ message: "Activated!" });
        } else res.status(404).send();
    } catch (e) { res.status(401).send(); }
});

async function sendGlobalPush(coinId, side, score) {
    try {
        const subs = await PushSubscription.find();
        const payload = JSON.stringify({ 
            title: `NEURAL TITAN: ${coinId}`, 
            body: `AI Verdict: ${side} (Score: ${score})` 
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

initTitanStream();
updateHtfLevels();
setInterval(updateHtfLevels, 3600000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> NEURAL TITAN v9.5 VISION READY <<< `);
    console.log(`=========================================`);
});