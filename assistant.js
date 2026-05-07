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

// --- CONFIGURATION (DIGITAL FORTRESS v9.9 PRO IMMORTAL) ---
const CONFIG = {
    API_KEY_GEMINI: (process.env.API_KEY_GEMINI || "").trim(),
    // 🎯 ПРИОРИТЕТ НА PRO МОДЕЛЬ
    GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.5-pro").trim().replace(/['"]+/g, ''),
    FALLBACK_MODEL: "gemini-2.5-flash", // Резерв на случай критического перегруза Pro
    JWT_SECRET: (process.env.JWT_SECRET || "").trim(),
    MONGO_URI: (process.env.MONGO_URI || "").trim(),
    ENCRYPTION_KEY: (process.env.ENCRYPTION_KEY || "").trim(),
    ALGORITHM: 'aes-256-cbc',
    VAPID_PUBLIC: (process.env.VAPID_PUBLIC || "").trim(),
    VAPID_PRIVATE: (process.env.VAPID_PRIVATE || "").trim()
};

// --- ИНИЦИАЛИЗАЦИЯ ИИ (ДВУХУРОВНЕВАЯ ЗАЩИТА) ---
const genAI = new GoogleGenerativeAI(CONFIG.API_KEY_GEMINI);
const primaryModel = genAI.getGenerativeModel({ model: CONFIG.GEMINI_MODEL });
const secondaryModel = genAI.getGenerativeModel({ model: CONFIG.FALLBACK_MODEL });

// --- СИСТЕМНЫЕ ПЕРЕМЕННЫЕ (ОПТИМИЗАЦИЯ И ЗАЩИТА) ---
let aiQueue = 0;      
let aiCallsLastMinute = 0;
const MAX_AI_CALLS_PER_MIN = 1000; 
const MAX_ACTIVE_SIGNALS = 3; 
const SYSTEM_DAILY_LOSS_LIMIT = 300; 
const VERDICT_TTL_SECONDS = 60 * 60 * 24 * 30;
const VERDICT_OUTCOME_CANDLES = 24;
const VERDICT_OUTCOME_INTERVAL_MS = 5 * 60 * 1000;

// 🎯 СНАЙПЕРСКИЕ ПРЕДОХРАНИТЕЛИ 
let lastGlobalAiCall = 0; 
const coinAiCooldowns = {}; 

let userCache = {}; 
const CACHE_TTL = 60000; 

setInterval(() => { 
    if (aiCallsLastMinute > 0) {
        console.log(`🧹 [System]: Сброс счетчика API. Запросов за минуту: ${aiCallsLastMinute}`);
        aiCallsLastMinute = 0; 
    }
}, 60000);

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

webpush.setVapidDetails('mailto:support@jsculptor.com', CONFIG.VAPID_PUBLIC, CONFIG.VAPID_PRIVATE);

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const connectDB = async () => {
    try {
        await mongoose.connect(CONFIG.MONGO_URI);
        console.log("✅ [NEURAL TITAN]: Fortress Engine v9.9 Digital Online (IMMORTAL PRO SIEGE)");
        syncWithDatabase();
    } catch (err) { 
        console.error("❌ DB Connection Error:", err);
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
    reason: String, score: Number, reasoning_detailed: String,
    rr: Number, 
    timestamp: { type: Date, default: Date.now }
}));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    pair: String, type: String, entry: Number, exit: Number, sl: Number, tp: Number,
    result: String, profitCash: Number, rr: Number, grade: String, reason: String,
    ai_confidence: Number, ai_reasoning: String,
    timestamp: { type: Date, default: Date.now }
}));

const aiVerdictSchema = new mongoose.Schema({
    coinId: { type: String, index: true },
    pair: String,
    action: { type: String, index: true },
    strategy: String,
    reason: String,
    confidence: Number,
    marketScore: Number,
    scoreDetails: [String],
    price: Number,
    entry: Number,
    tp: Number,
    sl: Number,
    rr: Number,
    side: String,
    outcomeStatus: { type: String, default: 'PENDING', index: true },
    outcome: { type: String, default: null },
    outcomePrice: Number,
    outcomeCandles: Number,
    maxFavorablePct: Number,
    maxAdversePct: Number,
    evaluatedAt: Date,
    timestamp: { type: Date, default: Date.now, expires: VERDICT_TTL_SECONDS }
});
aiVerdictSchema.index({ outcomeStatus: 1, timestamp: 1 });
const AIVerdict = mongoose.model('AIVerdict', aiVerdictSchema);

const ASSETS = [
    { id: 'BTC', symbol: 'BTCUSDT' }, { id: 'ETH', symbol: 'ETHUSDT' },
    { id: 'SOL', symbol: 'SOLUSDT' }, { id: 'BNB', symbol: 'BNBUSDT' },
    { id: 'XRP', symbol: 'XRPUSDT' }, { id: 'ADA', symbol: 'ADAUSDT' },
    { id: 'DOGE', symbol: 'DOGEUSDT' }, { id: 'POL', symbol: 'POLUSDT' },
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

// ====================================================================
// --- 1. MEXC REST API ENGINE ---
// ====================================================================
const MEXC_API = 'https://api.mexc.com/api/v3';
const axiosConfig = { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };

function normalizeMarketSymbol(symbol) {
    const raw = String(symbol || '').toUpperCase().replace('/', '').trim();
    if (!raw || raw === 'GOLD' || raw === 'XAUUSDT') return null;
    const asset = ASSETS.find(a => a.id === raw || a.symbol === raw);
    if (asset && asset.id !== 'GOLD') return asset.symbol;
    return raw.endsWith('USDT') ? raw : `${raw}USDT`;
}

function mapMexcInterval(interval) {
    const map = { '1h': '60m', '4h': '240m', '1d': '1d' };
    return map[interval] || interval;
}

async function fetchCandleData(symbol, interval = '15m', limit = 40) {
    try {
        const mexcSymbol = normalizeMarketSymbol(symbol);
        if(!mexcSymbol) return null; 
        const mexcInterval = mapMexcInterval(interval); 
        const url = `${MEXC_API}/klines?symbol=${mexcSymbol}&interval=${mexcInterval}&limit=${limit}`;
        const res = await axios.get(url, axiosConfig);
        return res.data.map(c => [
            new Date(c[0]).toLocaleTimeString('en-GB'), parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4])
        ]);
    } catch (e) { return null; }
}

async function fetchCandleObjects(symbol, interval = '15m', limit = 40) {
    try {
        const mexcSymbol = normalizeMarketSymbol(symbol);
        if(!mexcSymbol) return null;
        const mexcInterval = mapMexcInterval(interval); 
        const url = `${MEXC_API}/klines?symbol=${mexcSymbol}&interval=${mexcInterval}&limit=${limit}`;
        const res = await axios.get(url, axiosConfig);
        return res.data.map(c => ({
            time: Number(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4])
        })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.close));
    } catch (e) { return null; }
}

async function updateHtfLevels() {
    for (const asset of ASSETS) {
        if(asset.id === 'GOLD') continue; 
        try {
            const url = `${MEXC_API}/klines?symbol=${asset.symbol.toUpperCase()}&interval=60m&limit=24`;
            const res = await axios.get(url, axiosConfig);
            if (res.data && res.data.length > 0) {
                orderFlowTracker[asset.id].htfHigh = Math.max(...res.data.map(c => parseFloat(c[2])));
                orderFlowTracker[asset.id].htfLow = Math.min(...res.data.map(c => parseFloat(c[3])));
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 150));
    }
}

// ====================================================================
// --- 2. BYBIT WEBSOCKET ENGINE ---
// ====================================================================
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';

function initTitanStream() {
    const ws = new WebSocket(BYBIT_WS);
    let pingTimeout;

    function heartbeat() {
        clearTimeout(pingTimeout);
        pingTimeout = setTimeout(() => { ws.terminate(); }, 35000); 
    }

    ws.on('open', () => { 
        console.log("📡 [Hybrid WS]: Connected to Bybit Market Flow.");
        heartbeat();
        const args = [];
        const wsAssets = ASSETS.filter(a => a.id !== 'GOLD');
        wsAssets.forEach(a => {
            args.push(`publicTrade.${a.symbol}`);
            args.push(`orderbook.50.${a.symbol}`);
        });
        for (let i = 0; i < args.length; i += 10) {
            ws.send(JSON.stringify({ "op": "subscribe", "args": args.slice(i, i + 10) }));
        }
    });

    setInterval(() => { if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({"req_id": "100001", "op": "ping"})); }, 20000);

    ws.on('message', (data) => {
        try {
            heartbeat();
            const payload = JSON.parse(data);
            if (payload.topic) {
                const topicParts = payload.topic.split('.');
                const symbol = topicParts[topicParts.length - 1];
                const asset = ASSETS.find(a => a.symbol === symbol);
                if (!asset) return;
                const coinId = asset.id;

                if (payload.topic.startsWith('publicTrade')) payload.data.forEach(trade => processAggTrade(coinId, trade));
                else if (payload.topic.startsWith('orderbook')) processOrderbook(coinId, payload.data);
            }
        } catch (e) {}
    });

    ws.on('close', () => { setTimeout(initTitanStream, 5000); });
    ws.on('error', () => {});
}

function processAggTrade(coinId, trade) {
    const price = parseFloat(trade.p);
    const tracker = orderFlowTracker[coinId];
    currentPrices[coinId] = price;
    
    const qty = parseFloat(trade.v);
    const delta = trade.S === 'Sell' ? -qty : qty;
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
    if (!depth || !depth.b || !depth.a) return;
    const bids = depth.b.slice(0, 5).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    const asks = depth.a.slice(0, 5).reduce((acc, curr) => acc + parseFloat(curr[1]), 0);
    if (asks > 0 || bids > 0) tracker.imbalance = asks > 0 ? bids / asks : 1;
}

function updateTechnicalScore(coinId, price) {
    const tracker = orderFlowTracker[coinId];
    let score = 0; let reasons = [];

    if (tracker.sweepSide) { score += 35; reasons.push("LIQUIDITY_SWEEP"); }

    const clusterVolUSDT = tracker.absorptionBuffer.reduce((a, b) => a + (b.qty * b.price), 0);
    if (clusterVolUSDT > 150000) { score += 25; reasons.push("INST_VOLUME"); }
    if (clusterVolUSDT > 300000 && Math.abs(tracker.deltaVelocity) < 30) { score += 10; reasons.push("ABSORPTION"); }

    if (tracker.imbalance > 1.6 || tracker.imbalance < 0.6) { score += 15; reasons.push("ORDER_FLOW"); }

    if (Math.abs(tracker.deltaVelocity) > 40) { score += 10; reasons.push("VELOCITY"); }

    tracker.currentScore = score;
    tracker.scoreDetails = reasons;
}

// --- 🧠 ГИБРИДНЫЙ МОДУЛЬ ИИ И САМООБУЧЕНИЯ ---
function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function buildSignalPlan(verdict, entryPrice) {
    const action = String(verdict.action || 'WATCH').toUpperCase();
    const side = action.includes('LONG') ? 'LONG' : (action.includes('SHORT') ? 'SHORT' : null);
    const strategy = verdict.strategy || 'HYBRID';
    let rr = 2.2;

    if (strategy === 'RANGE') rr = 1.5;
    else if (strategy === 'TREND') rr = 2.0;
    else if (strategy === 'SMC') rr = 2.5;

    let tp = safeNumber(verdict.tp, 0);
    let sl = safeNumber(verdict.sl, 0);

    if (side && entryPrice > 0 && (tp === 0 || sl === 0)) {
        const offsetSL = entryPrice * 0.01;
        const offsetTP = offsetSL * rr;
        tp = side === 'LONG' ? entryPrice + offsetTP : entryPrice - offsetTP;
        sl = side === 'LONG' ? entryPrice - offsetSL : entryPrice + offsetSL;
    }

    return { action, side, strategy, rr, tp, sl };
}

async function recordAIVerdict(verdict, plan) {
    const coinId = String(verdict.id || '').toUpperCase();
    if (!coinId || coinId === 'GOLD' || !orderFlowTracker[coinId]) return null;

    try {
        const tracker = orderFlowTracker[coinId];
        return await AIVerdict.create({
            coinId,
            pair: `${coinId}/USDT`,
            action: plan.action,
            strategy: plan.strategy,
            reason: String(verdict.reason || '').slice(0, 700),
            confidence: safeNumber(verdict.confidence, 0),
            marketScore: tracker.currentScore || 0,
            scoreDetails: (tracker.scoreDetails || []).slice(0, 8),
            price: safeNumber(currentPrices[coinId], 0),
            entry: plan.side ? safeNumber(currentPrices[coinId], 0) : null,
            tp: plan.side ? plan.tp : null,
            sl: plan.side ? plan.sl : null,
            rr: plan.side ? plan.rr : null,
            side: plan.side,
            outcomeStatus: 'PENDING'
        });
    } catch (e) {
        console.error(`AIVerdict log error: ${e.message}`);
        return null;
    }
}

function calculateVerdictOutcome(verdict, candles) {
    const entry = safeNumber(verdict.entry || verdict.price, 0);
    if (!entry || candles.length === 0) return null;

    const isLong = verdict.side === 'LONG';
    let maxFavorablePct = 0;
    let maxAdversePct = 0;

    for (let i = 0; i < candles.length; i++) {
        const high = safeNumber(candles[i].high ?? candles[i][2], 0);
        const low = safeNumber(candles[i].low ?? candles[i][3], 0);
        const close = safeNumber(candles[i].close ?? candles[i][4], 0);

        if (verdict.side) {
            const favorable = isLong ? ((high - entry) / entry) * 100 : ((entry - low) / entry) * 100;
            const adverse = isLong ? ((entry - low) / entry) * 100 : ((high - entry) / entry) * 100;
            maxFavorablePct = Math.max(maxFavorablePct, favorable);
            maxAdversePct = Math.max(maxAdversePct, adverse);

            if (isLong) {
                if (low <= verdict.sl) return { outcome: 'LOSS', price: verdict.sl, candles: i + 1, maxFavorablePct, maxAdversePct };
                if (high >= verdict.tp) return { outcome: 'WIN', price: verdict.tp, candles: i + 1, maxFavorablePct, maxAdversePct };
            } else {
                if (high >= verdict.sl) return { outcome: 'LOSS', price: verdict.sl, candles: i + 1, maxFavorablePct, maxAdversePct };
                if (low <= verdict.tp) return { outcome: 'WIN', price: verdict.tp, candles: i + 1, maxFavorablePct, maxAdversePct };
            }
        } else {
            maxFavorablePct = Math.max(maxFavorablePct, Math.abs(((high - entry) / entry) * 100));
            maxAdversePct = Math.max(maxAdversePct, Math.abs(((entry - low) / entry) * 100));
        }

        if (i + 1 >= VERDICT_OUTCOME_CANDLES) {
            return {
                outcome: verdict.side ? 'EXPIRED' : 'OBSERVED',
                price: close,
                candles: i + 1,
                maxFavorablePct,
                maxAdversePct
            };
        }
    }

    return null;
}

async function evaluatePendingVerdicts() {
    try {
        const minAge = new Date(Date.now() - 15 * 60 * 1000);
        const pending = await AIVerdict.find({
            outcomeStatus: 'PENDING',
            timestamp: { $lte: minAge }
        }).sort({ timestamp: 1 }).limit(20).lean();

        for (const verdict of pending) {
            const rawCandles = await fetchCandleObjects(verdict.coinId, '15m', 120);
            const createdAt = new Date(verdict.timestamp).getTime();
            const candles = rawCandles ? rawCandles.filter(c => c.time >= createdAt) : null;
            if (!candles || candles.length === 0) continue;

            const outcome = calculateVerdictOutcome(verdict, candles);
            if (!outcome) continue;

            await AIVerdict.updateOne({ _id: verdict._id }, {
                $set: {
                    outcomeStatus: 'DONE',
                    outcome: outcome.outcome,
                    outcomePrice: outcome.price,
                    outcomeCandles: outcome.candles,
                    maxFavorablePct: Number(outcome.maxFavorablePct.toFixed(3)),
                    maxAdversePct: Number(outcome.maxAdversePct.toFixed(3)),
                    evaluatedAt: new Date()
                }
            });
        }
    } catch (e) {
        console.error(`AIVerdict outcome error: ${e.message}`);
    }
}

// 🛡️ ХЕЛПЕР CSV-УПАКОВКИ (Экономия 60% токенов)
function packToCSV(candles) {
    if (!candles) return "";
    return candles.map(c => 
        `${c[1].toFixed(4)},${c[2].toFixed(4)},${c[3].toFixed(4)},${c[4].toFixed(4)}`
    ).join('|');
}

async function runMarketScan() {
    if (aiCallsLastMinute >= MAX_AI_CALLS_PER_MIN) return;

    if (Date.now() - lastGlobalAiCall < 60000) return;

    const candidates = Object.keys(orderFlowTracker)
        .filter(id => {
            const tracker = orderFlowTracker[id];
            const isHighScoring = tracker.currentScore >= 80; 
            const isNotBanned = !coinAiCooldowns[id] || Date.now() > coinAiCooldowns[id];
            const isReadyForAnalysis = (Date.now() - lastAiAnalysis[id] > 240000); 
            return isHighScoring && isNotBanned && isReadyForAnalysis;
        })
        .sort((a, b) => orderFlowTracker[b].currentScore - orderFlowTracker[a].currentScore)
        .slice(0, 1); 

    if (candidates.length === 0) return;

    const id = candidates[0];
    if(id === 'GOLD') return;

    lastGlobalAiCall = Date.now();
    aiCallsLastMinute++;
    broadcastHackerLog(`[AI Scanner]: Снайперский захват: ${id} (Score: ${orderFlowTracker[id].currentScore})`, 'AI');

    const candles1h = await fetchCandleData(id, '1h', 500);  
    const candles15m = await fetchCandleData(id, '15m', 500); 
    
    if (!candles1h || !candles15m) return;

    const csvH1 = packToCSV(candles1h);
    const csvM15 = packToCSV(candles15m);

    let learningContext = "Отсутствует недавняя история сделок.";
    try {
        const recentTrades = await Trade.find().sort({ timestamp: -1 }).limit(5);
        if (recentTrades.length > 0) {
            learningContext = recentTrades.map(t => 
                `[Монета: ${t.pair}, Тип: ${t.type}, Результат: ${t.result}, Уверенность: ${t.ai_confidence}%]`
            ).join("\n");
        }
    } catch (e) {}

    const prompt = `ACT AS A SENIOR INSTITUTIONAL RISK MANAGER & SMC TRADER. 
    DATA FORMAT: CSV (Open,High,Low,Close) separated by '|'.
    Your primary goal is NOT to find a trade, but to AVOID A TRAP.

    STRICT RULES (LONG-TERM ANALYSIS):
    1. DEEP HTF CHECK: Analyze the 500 H1 candles. Identify major Liquidity Pools and Order Blocks from the last 20+ days.
    2. TREND ALIGNMENT: NEVER go against the primary H1 trend established over the last 10 days.
    3. ANTI-CHASING: If price moved > 3% in last 2 hours, output WATCH.
    4. SMC PRECISION: Look for M15 manipulation (Sweep) within H1 zones of interest.
    5. SELF-LEARNING: Analyze failures in memory. DO NOT repeat them.

    [SELF-LEARNING MEMORY]:
    ${learningContext}

    [ASSET]: ${id} | PRICE: ${currentPrices[id]}
    [H1_CSV]: ${csvH1}
    [M15_CSV]: ${csvM15}
    
    OUTPUT ONLY JSON ARRAY. Format:
    [{"id": "${id}", "action": "EXECUTE_LONG", "strategy": "SMC", "reason": "...", "confidence": 92, "tp": 0, "sl": 0}]
    Be extremely picky. 95% of cases should be WATCH.`;

    // 🛡️ СИСТЕМА ОСАДНОГО ТАРАНА 2.0: 5 попыток + Экспоненциальная пауза + Fallback на Flash
    let maxRetries = 5;
    let attempt = 0;
    let success = false;
    let text;

    while (attempt < maxRetries && !success) {
        try {
            const result = await primaryModel.generateContent(prompt);
            const response = await result.response;
            text = response.text();
            success = true; 
        } catch (e) {
            attempt++;
            if (e.message.includes('503')) {
                // Экспоненциальное ожидание: (1*1*2000+1000)=3с, (2*2*2000+1000)=9с, (3*3*2000+1000)=19с...
                const waitTime = Math.pow(attempt, 2) * 2000 + 1000;
                console.log(`⚠️ [AI Engine]: Сервер Google перегружен (503). Попытка ${attempt}/${maxRetries} через ${waitTime/1000}с...`);
                await new Promise(r => setTimeout(r, waitTime));
            } else {
                console.error(`❌ [AI Error]: Ошибка Gemini API: ${e.message}`);
                break; // Если ошибка не 503, прерываем цикл для этой попытки
            }
        }
    }

    // 🚀 ФИНАЛЬНЫЙ РЫВОК: Если Pro не ответила, пробуем Flash
    if (!success) {
        try {
            console.log(`📡 [Fallback]: Пробуем резервную модель Flash...`);
            const result = await secondaryModel.generateContent(prompt);
            const response = await result.response;
            text = response.text();
            success = true;
        } catch (e) {
            console.error(`❌ [Critical]: Резервная модель тоже недоступна.`);
            broadcastHackerLog(`[System]: ИИ временно недоступен во всем регионе.`, 'ALERT');
            return;
        }
    }

    try {
        const cleanJson = text.replace(/\x60\x60\x60json/g, '').replace(/\x60\x60\x60/g, '').trim();
        const verdicts = JSON.parse(cleanJson);

        for (const v of verdicts) {
            lastAiAnalysis[v.id] = Date.now();
            const plan = buildSignalPlan(v, safeNumber(currentPrices[v.id], 0));
            await recordAIVerdict(v, plan);

            if (v.action === 'WATCH' || !v.action.includes('EXECUTE')) {
                coinAiCooldowns[v.id] = Date.now() + 30 * 60 * 1000;
                broadcastHackerLog(`[System]: ${v.id} отклонен ИИ. Заморозка на 30 мин.`, 'INFO');
                continue;
            }

            if (v.action.includes('EXECUTE') && v.confidence >= 85 && !activeMasterSignals[v.id]) { 
                const side = v.action.includes('LONG') ? 'LONG' : 'SHORT';
                
                let dynamicRR = 2.2; 
                if (v.strategy === 'RANGE') dynamicRR = 1.5;
                else if (v.strategy === 'TREND') dynamicRR = 2.0;
                else if (v.strategy === 'SMC') dynamicRR = 2.5;

                let tp = v.tp, sl = v.sl;
                if (tp === 0 || sl === 0) {
                    const offsetSL = currentPrices[v.id] * 0.01; 
                    const offsetTP = offsetSL * dynamicRR; 
                    
                    tp = side === 'LONG' ? currentPrices[v.id] + offsetTP : currentPrices[v.id] - offsetTP;
                    sl = side === 'LONG' ? currentPrices[v.id] - offsetSL : currentPrices[v.id] + offsetSL;
                }

                const detailedReason = `[${v.strategy || 'HYBRID'}] ${v.reason}`;
                await createMasterSignal(v.id, currentPrices[v.id], side, v.confidence, detailedReason, tp, sl, dynamicRR);
            }
        }
    } catch (parseError) {
        console.error(`❌ [Parse Error]: Ошибка разбора ответа ИИ:`, parseError);
    }
}

// 🛡️ ИНТЕРВАЛ СНАЙПЕРА: Проверяем очередь каждую минуту (60000ms)
setInterval(runMarketScan, 60000); 

async function createMasterSignal(coinId, entry, side, score, reason, tp, sl, rr = 2.2) {
    if (Object.keys(activeMasterSignals).length >= MAX_ACTIVE_SIGNALS) return;
    try {
        const signal = new MasterSignal({
            coinId, pair: `${coinId}/USDT`, type: `🏦 ${coinId} ${side}`,
            entry, sl, tp, size: 50, confidence: score, grade: 'Fortress v9.9 Digital PRO', 
            timeLabel: new Date().toLocaleTimeString('ru-RU'),
            reason: `[AI]: ${reason}`, reasoning_detailed: reason, score, rr
        });
        await signal.save();
        activeMasterSignals[coinId] = signal.toObject();
        broadcastHackerLog(`🎯 NEURAL ENTRY: ${coinId} ${side}`, 'ENTRY');
        sendGlobalPush(coinId, side, score);
    } catch (e) {}
}

function checkMasterExecution(coinId, price) {
    const sig = activeMasterSignals[coinId];
    if (!sig || sig.isProcessing) return; 

    const isLong = sig.type.includes('LONG');
    const hitTP = isLong ? price >= sig.tp : price <= sig.tp;
    const hitSL = isLong ? price <= sig.sl : price >= sig.sl;

    if (hitTP || hitSL) {
        sig.isProcessing = true; 
        const result = hitTP ? "SUCCESS" : "FAILED";
        const exitPrice = hitTP ? sig.tp : sig.sl;
        finalizeMasterTrade(coinId, result, exitPrice);
    }
}

async function finalizeMasterTrade(coinId, result, exitPrice) {
    const sig = activeMasterSignals[coinId];
    if (!sig) return;

    delete activeMasterSignals[coinId];

    try {
        const isLong = sig.type.includes('LONG');
        const profitPerUnit = (exitPrice - sig.entry) * (isLong ? 1 : -1);
        
        const tradeDoc = new Trade({
            userId: null, 
            pair: sig.pair, type: sig.type, entry: sig.entry,
            exit: exitPrice, sl: sig.sl, tp: sig.tp, result,
            profitCash: profitPerUnit * sig.size, rr: sig.rr || 2.2, grade: sig.grade, 
            reason: sig.reason, ai_confidence: sig.confidence, ai_reasoning: sig.reasoning_detailed
        });
        await tradeDoc.save();
        
        await MasterSignal.deleteOne({ _id: sig._id });
        broadcastHackerLog(`🏁 ${coinId} Закрыт: ${result}`, 'INFO');
        syncWithDatabase();
    } catch (e) {
        console.error("Ошибка при закрытии сделки:", e);
    }
}

async function getPersonalStats() {
    const trades = await Trade.find().sort({ timestamp: 1 });
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

app.post('/api/subscribe', async (req, res) => {
    try {
        const subscription = req.body;
        const exists = await PushSubscription.findOne({ "subscription.endpoint": subscription.endpoint });
        
        if (!exists) {
            await new PushSubscription({ subscription }).save();
            console.log("🔔 [System]: Новое устройство подписано на уведомления!");
        }
        res.status(201).json({ message: "Subscribed" });
    } catch (e) {
        console.error("Push Error:", e);
        res.status(500).json({ error: "Failed to subscribe" });
    }
});

app.get('/api/data', async (req, res) => {
    let isPrem = false; let userId = null;
    const auth = req.headers.authorization;
    
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], CONFIG.JWT_SECRET);
            userId = decoded.id;
            
            const now = Date.now();
            if (!userCache[userId] || (now - userCache[userId].lastUpdate > CACHE_TTL)) {
                const user = await User.findById(userId);
                
                if (user) {
                    if (user.subscriptionStatus === 'active' && user.subscriptionExpires && user.subscriptionExpires < new Date(now)) {
                        user.subscriptionStatus = 'inactive';
                        await user.save(); 
                        console.log(`[ACCESS DENIED]: Подписка пользователя ${user.email} истекла.`);
                    }
                    isPrem = user.subscriptionStatus === 'active';
                }

                const statsData = isPrem ? await getPersonalStats() : { total: 0, winRate: 0 };
                const tradeHistory = isPrem ? await Trade.find().sort({ timestamp: -1 }).limit(10) : [];
                
                userCache[userId] = { isPrem, statsData, tradeHistory, lastUpdate: now };
            } else {
                isPrem = userCache[userId].isPrem;
            }
        } catch (e) {}
    }

    const statsData = isPrem && userId && userCache[userId] ? userCache[userId].statsData : { total: 0, winRate: 0 };
    const historyData = isPrem && userId && userCache[userId] ? userCache[userId].tradeHistory : [];

    const watchlist = Object.keys(orderFlowTracker)
        .map(id => ({ id, score: orderFlowTracker[id].currentScore, reasons: orderFlowTracker[id].scoreDetails }))
        .sort((a, b) => b.score - a.score).slice(0, 10);

    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? Object.values(activeMasterSignals) : [], 
        tradeHistory: historyData, 
        stats: statsData, 
        premium: isPrem, 
        orderFlow: orderFlowTracker,
        watchlist: watchlist
    });
});

app.get('/api/klines', async (req, res) => {
    try {
        const symbol = normalizeMarketSymbol(req.query.symbol);
        const interval = ['1m', '5m', '15m', '30m', '60m', '1h', '4h', '1d'].includes(req.query.interval) ? req.query.interval : '60m';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 120, 20), 500);

        if (!symbol) return res.status(400).json({ error: 'Unsupported symbol' });

        const mexcInterval = mapMexcInterval(interval);
        const url = `${MEXC_API}/klines?symbol=${symbol}&interval=${mexcInterval}&limit=${limit}`;
        const response = await axios.get(url, axiosConfig);
        const candles = response.data.map(c => ({
            time: Math.floor(Number(c[0]) / 1000),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4])
        })).filter(c => Number.isFinite(c.time) && Number.isFinite(c.close));

        res.json({ symbol, interval: mexcInterval, candles });
    } catch (e) {
        res.status(502).json({ error: 'Chart data unavailable' });
    }
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
            
            if (userCache[decoded.id]) delete userCache[decoded.id];
            
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

initTitanStream();
updateHtfLevels();
setInterval(updateHtfLevels, 3600000);
setInterval(evaluatePendingVerdicts, VERDICT_OUTCOME_INTERVAL_MS);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> NEURAL TITAN PRO SIEGE READY <<< `);
    console.log(`=========================================`);
});