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
let isAiScanning = false; // 🔒 Блокиратор параллельных запросов (ЗАМОК)
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

// 🛡️ БАЗА ДАННЫХ ДЛЯ ДИРЕКТИВЫ ВЛАДЕЛЬЦА (JSculptor-TITAN)
const MacroConfig = mongoose.model('MacroConfig', new mongoose.Schema({
    directive: { type: String, default: "Standard institutional SMC logic. Awaiting Chief Analyst Macro Directive." },
    updatedBy: String,
    updatedAt: { type: Date, default: Date.now }
}));

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
let marketRegime = { label: 'WARMING_UP', risk: 'WAIT', reason: 'Waiting for live BTC and derivatives flow.', updatedAt: Date.now() };
let analyticsCache = { data: null, lastUpdate: 0 };
let funnelMetrics = { dayKey: new Date().toISOString().slice(0, 10), opportunitiesToday: 0, lastOpportunityAt: null, lastOpportunityCoin: null, lastOpportunityScore: 0 };

ASSETS.forEach(a => {
    orderFlowTracker[a.id] = {
        cvd: 0, lastCVD: 0, deltaVelocity: 0,
        absorptionBuffer: [], imbalance: 0,
        htfHigh: 0, htfLow: 0, sweepSide: null,
        currentScore: 0, scoreDetails: [],
        fundingRate: 0, openInterest: 0, openInterestValue: 0,
        volume24h: 0, turnover24h: 0, liquidationsLongUSDT: 0, liquidationsShortUSDT: 0,
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
            args.push(`tickers.${a.symbol}`);
            args.push(`allLiquidation.${a.symbol}`);
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
                else if (payload.topic.startsWith('tickers')) processTicker(coinId, payload.data);
                else if (payload.topic.startsWith('allLiquidation')) processLiquidations(coinId, payload.data);
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

function processTicker(coinId, data) {
    const tracker = orderFlowTracker[coinId];
    if (!tracker || !data) return;
    if (data.lastPrice) currentPrices[coinId] = safeNumber(data.lastPrice, currentPrices[coinId]);
    if (data.fundingRate) tracker.fundingRate = safeNumber(data.fundingRate, tracker.fundingRate);
    if (data.openInterest) tracker.openInterest = safeNumber(data.openInterest, tracker.openInterest);
    if (data.openInterestValue) tracker.openInterestValue = safeNumber(data.openInterestValue, tracker.openInterestValue);
    if (data.volume24h) tracker.volume24h = safeNumber(data.volume24h, tracker.volume24h);
    if (data.turnover24h) tracker.turnover24h = safeNumber(data.turnover24h, tracker.turnover24h);
    updateTechnicalScore(coinId, currentPrices[coinId]);
    if (coinId === 'BTC') updateMarketRegime();
}

function processLiquidations(coinId, data) {
    const tracker = orderFlowTracker[coinId];
    if (!tracker || !data) return;
    const events = Array.isArray(data) ? data : [data];
    const now = Date.now();

    events.forEach(liq => {
        const price = safeNumber(liq.p, 0);
        const size = safeNumber(liq.v, 0);
        const value = price * size;
        if (!value) return;

        if (liq.S === 'Buy') tracker.liquidationsLongUSDT += value;
        else if (liq.S === 'Sell') tracker.liquidationsShortUSDT += value;
    });

    tracker.liquidationsLongUSDT *= 0.92;
    tracker.liquidationsShortUSDT *= 0.92;
    tracker.lastUpdate = now;
    updateTechnicalScore(coinId, currentPrices[coinId]);
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

    if (Math.abs(tracker.fundingRate) > 0.0006) { score += 8; reasons.push("FUNDING_STRESS"); }

    const liqTotal = tracker.liquidationsLongUSDT + tracker.liquidationsShortUSDT;
    if (liqTotal > 250000) { score += 12; reasons.push("LIQUIDATION_CLUSTER"); }

    tracker.currentScore = score;
    tracker.scoreDetails = reasons;
}

// --- 🧠 ГИБРИДНЫЙ МОДУЛЬ ИИ И САМООБУЧЕНИЯ ---
function updateMarketRegime() {
    const btc = orderFlowTracker.BTC;
    const liqTotal = (btc.liquidationsLongUSDT || 0) + (btc.liquidationsShortUSDT || 0);
    let label = 'NEUTRAL';
    let risk = 'NORMAL';
    const reasons = [];

    if (btc.currentScore >= 80 && btc.sweepSide) {
        label = 'LIQUIDITY_EVENT';
        risk = 'HIGH_SELECTIVITY';
        reasons.push(`BTC sweep ${btc.sweepSide}`);
    }

    if (Math.abs(btc.fundingRate || 0) > 0.0008) {
        risk = 'HIGH_SELECTIVITY';
        reasons.push(`Funding stress ${(btc.fundingRate * 100).toFixed(3)}%`);
    }

    if (liqTotal > 500000) {
        label = 'FORCED_FLOW';
        risk = 'HIGH_SELECTIVITY';
        reasons.push('BTC liquidation cluster');
    }

    if (btc.deltaVelocity > 80 && btc.imbalance > 1.25) {
        label = 'RISK_ON';
        reasons.push('BTC positive delta and bid pressure');
    } else if (btc.deltaVelocity < -80 && btc.imbalance < 0.8) {
        label = 'RISK_OFF';
        reasons.push('BTC negative delta and ask pressure');
    }

    marketRegime = {
        label,
        risk,
        reason: reasons.length ? reasons.join(' | ') : 'No dominant BTC regime pressure.',
        btcScore: btc.currentScore || 0,
        btcFundingRate: btc.fundingRate || 0,
        btcOpenInterestValue: btc.openInterestValue || 0,
        btcLiquidationsUSDT: Number(liqTotal.toFixed(2)),
        updatedAt: Date.now()
    };

    return marketRegime;
}

async function getVerdictAnalytics() {
    const now = Date.now();
    if (analyticsCache.data && now - analyticsCache.lastUpdate < 60000) return analyticsCache.data;

    try {
        const since = new Date(now - VERDICT_TTL_SECONDS * 1000);
        const weekSince = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const [total, pending, byAction, byOutcome, byStrategy, byCoin, activeWeekly, closedWeekly] = await Promise.all([
            AIVerdict.countDocuments({ timestamp: { $gte: since } }),
            AIVerdict.countDocuments({ outcomeStatus: 'PENDING', timestamp: { $gte: since } }),
            AIVerdict.aggregate([
                { $match: { timestamp: { $gte: since } } },
                { $group: { _id: '$action', count: { $sum: 1 } } }
            ]),
            AIVerdict.aggregate([
                { $match: { timestamp: { $gte: since }, outcomeStatus: 'DONE' } },
                { $group: { _id: '$outcome', count: { $sum: 1 } } }
            ]),
            AIVerdict.aggregate([
                { $match: { timestamp: { $gte: since }, outcomeStatus: 'DONE', side: { $ne: null } } },
                { $group: { _id: '$strategy', total: { $sum: 1 }, wins: { $sum: { $cond: [{ $eq: ['$outcome', 'WIN'] }, 1, 0] } } } },
                { $sort: { total: -1 } },
                { $limit: 5 }
            ]),
            AIVerdict.aggregate([
                { $match: { timestamp: { $gte: since }, outcomeStatus: 'DONE', side: { $ne: null } } },
                { $group: { _id: '$coinId', total: { $sum: 1 }, wins: { $sum: { $cond: [{ $eq: ['$outcome', 'WIN'] }, 1, 0] } } } },
                { $sort: { total: -1 } },
                { $limit: 8 }
            ]),
            MasterSignal.countDocuments({ timestamp: { $gte: weekSince } }),
            Trade.countDocuments({ timestamp: { $gte: weekSince } })
        ]);

        const actionMap = Object.fromEntries(byAction.map(x => [x._id || 'UNKNOWN', x.count]));
        const outcomeMap = Object.fromEntries(byOutcome.map(x => [x._id || 'UNKNOWN', x.count]));
        const executed = (actionMap.EXECUTE_LONG || 0) + (actionMap.EXECUTE_SHORT || 0);
        const wins = outcomeMap.WIN || 0;
        const losses = outcomeMap.LOSS || 0;
        const resolved = wins + losses;

        analyticsCache = {
            lastUpdate: now,
            data: {
                total,
                pending,
                watch: actionMap.WATCH || 0,
                executed,
                wins,
                losses,
                expired: outcomeMap.EXPIRED || 0,
                observed: outcomeMap.OBSERVED || 0,
                winRate: resolved ? Math.round((wins / resolved) * 100) : 0,
                executionRate: total ? Number(((executed / total) * 100).toFixed(1)) : 0,
                opportunitiesToday: funnelMetrics.opportunitiesToday,
                lastOpportunityCoin: funnelMetrics.lastOpportunityCoin,
                lastOpportunityScore: funnelMetrics.lastOpportunityScore,
                aiChecksToday: 0,
                watchToday: 0,
                signalsThisWeek: activeWeekly + closedWeekly,
                byStrategy: byStrategy.map(x => ({ strategy: x._id || 'UNKNOWN', total: x.total, winRate: x.total ? Math.round((x.wins / x.total) * 100) : 0 })),
                byCoin: byCoin.map(x => ({ coin: x._id, total: x.total, winRate: x.total ? Math.round((x.wins / x.total) * 100) : 0 }))
            }
        };

        const today = new Date(new Date().toISOString().slice(0, 10));
        const todayActions = await AIVerdict.aggregate([
            { $match: { timestamp: { $gte: today } } },
            { $group: { _id: '$action', count: { $sum: 1 } } }
        ]);
        const todayMap = Object.fromEntries(todayActions.map(x => [x._id || 'UNKNOWN', x.count]));
        analyticsCache.data.aiChecksToday = todayActions.reduce((sum, x) => sum + x.count, 0);
        analyticsCache.data.watchToday = todayMap.WATCH || 0;

        return analyticsCache.data;
    } catch (e) {
        console.error(`Analytics error: ${e.message}`);
        return analyticsCache.data || { total: 0, pending: 0, watch: 0, executed: 0, wins: 0, losses: 0, expired: 0, observed: 0, winRate: 0, executionRate: 0, byStrategy: [], byCoin: [] };
    }
}

function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getPercentMove(candles, periods = 24) {
    if (!candles || candles.length < periods + 1) return 0;
    const start = candles[candles.length - periods - 1][4];
    const end = candles[candles.length - 1][4];
    if (!start) return 0;
    return ((end - start) / start) * 100;
}

function getSessionContext() {
    const hour = new Date().getUTCHours();
    if (hour >= 0 && hour < 7) return { session: 'ASIA', risk: 'MEDIUM', note: 'Liquidity can be thinner; validate breakouts carefully.' };
    if (hour >= 7 && hour < 12) return { session: 'LONDON', risk: 'HIGH_OPPORTUNITY', note: 'London open often creates sweeps and directional expansion.' };
    if (hour >= 12 && hour < 17) return { session: 'NEW_YORK', risk: 'HIGH_OPPORTUNITY', note: 'NY overlap is the strongest institutional execution window.' };
    return { session: 'POST_NY', risk: 'LOWER_OPPORTUNITY', note: 'Late-session moves need stronger confirmation.' };
}

function buildMacroReport(assetId, assetCandles1h, btcCandles1h) {
    const btcStructure = analyzeMarketStructure(btcCandles1h, btcCandles1h, currentPrices.BTC);
    const assetMove24h = getPercentMove(assetCandles1h, 24);
    const btcMove24h = getPercentMove(btcCandles1h, 24);
    const relativeStrength24h = assetId === 'BTC' ? 0 : assetMove24h - btcMove24h;
    let marketBias = 'NEUTRAL';

    if (btcStructure.h1Trend === 'UPTREND' && btcMove24h > 0) marketBias = 'RISK_ON';
    else if (btcStructure.h1Trend === 'DOWNTREND' && btcMove24h < 0) marketBias = 'RISK_OFF';

    return {
        marketAnchor: 'BTC',
        marketBias,
        btcTrend: btcStructure.h1Trend,
        btcPremiumDiscount: btcStructure.premiumDiscount,
        btcMove24h: Number(btcMove24h.toFixed(3)),
        assetMove24h: Number(assetMove24h.toFixed(3)),
        relativeStrength24h: Number(relativeStrength24h.toFixed(3)),
        session: getSessionContext()
    };
}

function buildSignalPlan(verdict, entryPrice, riskContext = {}) {
    const action = String(verdict.action || 'WATCH').toUpperCase();
    const side = action.includes('LONG') ? 'LONG' : (action.includes('SHORT') ? 'SHORT' : null);
    const strategy = verdict.strategy || 'HYBRID';
    let rr = 2.2;

    if (strategy === 'RANGE') rr = 1.5;
    else if (strategy === 'TREND') rr = 2.0;
    else if (strategy === 'SMC') rr = 2.5;

    let tp = safeNumber(verdict.tp, 0);
    let sl = safeNumber(verdict.sl, 0);

    if (side && entryPrice > 0) {
        const atr = safeNumber(riskContext.m15Atr, 0);
        const atrMultiplier = strategy === 'RANGE' ? 1.2 : (strategy === 'SMC' ? 1.7 : 1.5);
        const minStop = entryPrice * 0.004;
        const maxStop = entryPrice * 0.02;
        const offsetSL = atr > 0 ? clamp(atr * atrMultiplier, minStop, maxStop) : entryPrice * 0.01;
        const fallbackTp = side === 'LONG' ? entryPrice + (offsetSL * rr) : entryPrice - (offsetSL * rr);
        const fallbackSl = side === 'LONG' ? entryPrice - offsetSL : entryPrice + offsetSL;
        const invalidLong = side === 'LONG' && (sl >= entryPrice || tp <= entryPrice);
        const invalidShort = side === 'SHORT' && (sl <= entryPrice || tp >= entryPrice);

        if (tp === 0 || sl === 0 || invalidLong || invalidShort) {
            tp = fallbackTp;
            sl = fallbackSl;
        }

        const risk = Math.abs(entryPrice - sl);
        const reward = Math.abs(tp - entryPrice);
        if (risk > 0 && reward / risk < rr) {
            tp = side === 'LONG' ? entryPrice + (risk * rr) : entryPrice - (risk * rr);
        }
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

function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][2];
        const low = candles[i][3];
        const prevClose = candles[i - 1][4];
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    const recent = trs.slice(-period);
    return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

function findSwingPoints(candles, lookback = 3) {
    const swings = { highs: [], lows: [] };
    if (!candles || candles.length < lookback * 2 + 3) return swings;

    for (let i = lookback; i < candles.length - lookback; i++) {
        const high = candles[i][2];
        const low = candles[i][3];
        let isHigh = true;
        let isLow = true;

        for (let j = i - lookback; j <= i + lookback; j++) {
            if (j === i) continue;
            if (candles[j][2] >= high) isHigh = false;
            if (candles[j][3] <= low) isLow = false;
        }

        if (isHigh) swings.highs.push({ index: i, price: high });
        if (isLow) swings.lows.push({ index: i, price: low });
    }

    return {
        highs: swings.highs.slice(-5),
        lows: swings.lows.slice(-5)
    };
}

function detectFairValueGaps(candles) {
    if (!candles || candles.length < 3) return [];
    const gaps = [];

    for (let i = 2; i < candles.length; i++) {
        const prev2 = candles[i - 2];
        const curr = candles[i];

        if (curr[3] > prev2[2]) {
            gaps.push({ type: 'BULLISH_FVG', from: prev2[2], to: curr[3], index: i });
        } else if (curr[2] < prev2[3]) {
            gaps.push({ type: 'BEARISH_FVG', from: curr[2], to: prev2[3], index: i });
        }
    }

    return gaps.slice(-5);
}

function analyzeMarketStructure(candles1h, candles15m, currentPrice) {
    const h1 = candles1h || [];
    const m15 = candles15m || [];
    const h1Swings = findSwingPoints(h1, 3);
    const m15Swings = findSwingPoints(m15, 3);
    const h1Atr = calculateATR(h1, 14);
    const m15Atr = calculateATR(m15, 14);
    const lastClose = currentPrice || (m15.length ? m15[m15.length - 1][4] : 0);
    const recentH1 = h1.slice(-96);
    const rangeHigh = recentH1.length ? Math.max(...recentH1.map(c => c[2])) : 0;
    const rangeLow = recentH1.length ? Math.min(...recentH1.map(c => c[3])) : 0;
    const rangeMid = rangeHigh && rangeLow ? (rangeHigh + rangeLow) / 2 : 0;
    const premiumDiscount = rangeMid && lastClose
        ? (lastClose > rangeMid ? 'PREMIUM' : 'DISCOUNT')
        : 'UNKNOWN';
    const lastSwingHigh = h1Swings.highs[h1Swings.highs.length - 1];
    const prevSwingHigh = h1Swings.highs[h1Swings.highs.length - 2];
    const lastSwingLow = h1Swings.lows[h1Swings.lows.length - 1];
    const prevSwingLow = h1Swings.lows[h1Swings.lows.length - 2];
    let trend = 'RANGE';

    if (lastSwingHigh && prevSwingHigh && lastSwingLow && prevSwingLow) {
        const higherHigh = lastSwingHigh.price > prevSwingHigh.price;
        const higherLow = lastSwingLow.price > prevSwingLow.price;
        const lowerHigh = lastSwingHigh.price < prevSwingHigh.price;
        const lowerLow = lastSwingLow.price < prevSwingLow.price;
        if (higherHigh && higherLow) trend = 'UPTREND';
        else if (lowerHigh && lowerLow) trend = 'DOWNTREND';
    }

    const lastM15Close = m15.length ? m15[m15.length - 1][4] : lastClose;
    const lastM15SwingHigh = m15Swings.highs[m15Swings.highs.length - 1];
    const lastM15SwingLow = m15Swings.lows[m15Swings.lows.length - 1];
    let structureBreak = 'NONE';

    if (lastM15SwingHigh && lastM15Close > lastM15SwingHigh.price) structureBreak = 'BOS_UP';
    else if (lastM15SwingLow && lastM15Close < lastM15SwingLow.price) structureBreak = 'BOS_DOWN';

    return {
        h1Trend: trend,
        h1Atr: Number(h1Atr.toFixed(6)),
        m15Atr: Number(m15Atr.toFixed(6)),
        h1RangeHigh: rangeHigh,
        h1RangeLow: rangeLow,
        h1RangeMid: rangeMid,
        premiumDiscount,
        lastH1SwingHigh: lastSwingHigh ? lastSwingHigh.price : null,
        lastH1SwingLow: lastSwingLow ? lastSwingLow.price : null,
        m15StructureBreak: structureBreak,
        recentM15Fvg: detectFairValueGaps(m15).map(g => ({
            type: g.type,
            from: Number(g.from.toFixed(6)),
            to: Number(g.to.toFixed(6))
        }))
    };
}

async function runMarketScan() {
    // 🛡️ ЗАМОК: Если бот еще думает над прошлой монетой, отменяем новый запуск
    if (isAiScanning) return; 

    if (aiCallsLastMinute >= MAX_AI_CALLS_PER_MIN) return;

    if (Date.now() - lastGlobalAiCall < 60000) return;

    const todayKey = new Date().toISOString().slice(0, 10);
    if (funnelMetrics.dayKey !== todayKey) {
        funnelMetrics = { dayKey: todayKey, opportunitiesToday: 0, lastOpportunityAt: null, lastOpportunityCoin: null, lastOpportunityScore: 0 };
        analyticsCache.lastUpdate = 0;
    }

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
    funnelMetrics.opportunitiesToday++;
    funnelMetrics.lastOpportunityAt = Date.now();
    funnelMetrics.lastOpportunityCoin = id;
    funnelMetrics.lastOpportunityScore = orderFlowTracker[id].currentScore;
    analyticsCache.lastUpdate = 0;

    // 🔒 ЗАКРЫВАЕМ ЗАМОК перед началом запросов и работы ИИ
    isAiScanning = true; 

    try {
        lastGlobalAiCall = Date.now();
        aiCallsLastMinute++;
        broadcastHackerLog(`[AI Scanner]: Снайперский захват: ${id} (Score: ${orderFlowTracker[id].currentScore})`, 'AI');

        const candles1h = await fetchCandleData(id, '1h', 500);  
        const candles15m = await fetchCandleData(id, '15m', 500); 
        
        if (!candles1h || !candles15m) return; // Замок откроется в блоке finally

        const btcCandles1h = id === 'BTC' ? candles1h : await fetchCandleData('BTC', '1h', 240);
        const csvH1 = packToCSV(candles1h);
        const csvM15 = packToCSV(candles15m);
        const flow = orderFlowTracker[id];
        const structureReport = analyzeMarketStructure(candles1h, candles15m, currentPrices[id]);
        const macroReport = buildMacroReport(id, candles1h, btcCandles1h || candles1h);
        const derivativesReport = {
            fundingRate: flow.fundingRate,
            openInterest: flow.openInterest,
            openInterestValue: flow.openInterestValue,
            volume24h: flow.volume24h,
            turnover24h: flow.turnover24h,
            liquidationsLongUSDT: Number(flow.liquidationsLongUSDT.toFixed(2)),
            liquidationsShortUSDT: Number(flow.liquidationsShortUSDT.toFixed(2)),
            globalRegime: updateMarketRegime()
        };
        const flowReport = {
            score: flow.currentScore,
            reasons: flow.scoreDetails,
            cvd: Number(flow.cvd.toFixed(3)),
            deltaVelocity: Number(flow.deltaVelocity.toFixed(3)),
            imbalance: Number(flow.imbalance.toFixed(3)),
            htfHigh: flow.htfHigh,
            htfLow: flow.htfLow,
            sweepSide: flow.sweepSide
        };

        let learningContext = "Отсутствует недавняя история сделок.";
        try {
            const recentTrades = await Trade.find().sort({ timestamp: -1 }).limit(5);
            if (recentTrades.length > 0) {
                learningContext = recentTrades.map(t => 
                    `[Монета: ${t.pair}, Тип: ${t.type}, Результат: ${t.result}, Уверенность: ${t.ai_confidence}%]`
                ).join("\n");
            }
        } catch (e) {}

        // 🛡️ ДОСТАЕМ ТВОЮ СВЕЖУЮ ДИРЕКТИВУ ПРЯМО ПЕРЕД ЗАПУСКОМ ИИ
        let currentMacroDirective = "Standard institutional SMC logic. Awaiting Chief Analyst Macro Directive.";
        try {
            const config = await MacroConfig.findOne({});
            if (config && config.directive) currentMacroDirective = config.directive;
        } catch (e) {}

        const prompt = `You are an elite, institutional-grade algorithmic trader operating within the JSculptor AI terminal. You receive raw H1 and M15 CSV market data and real-time technical scores.
        Your Task: Analyze the market structure and determine the current phase.
        1. If the market is trending: Apply strictly Smart Money Concepts (SMC). Look for Liquidity Sweeps, unmitigated Order Blocks on H1, and Market Structure Breaks (MSB) with Fair Value Gaps (FVG) on M15.
        2. If the market is ranging/consolidating: Switch to 'Level-to-Level' trading logic. Identify strong horizontal support and resistance boundaries, and look for clear deviations or rejections at these key levels.
        3. Respect MACRO_REPORT. Avoid weak altcoin longs when BTC is RISK_OFF unless the asset shows clear relative strength. Avoid weak shorts when BTC is RISK_ON unless the asset shows clear relative weakness.
        4. Respect DERIVATIVES_REPORT. Funding stress, open-interest expansion, and liquidation clusters must confirm the trade idea; otherwise WATCH.
        
        [CRITICAL MACRO OVERRIDE FROM CHIEF ANALYST (JSculptor-TITAN)]:
        ${currentMacroDirective}

        Mindset: You do not gamble. You seek confluence between the technical score and your structural analysis. Protect capital at all costs. Respond with 'EXECUTE_LONG' or 'EXECUTE_SHORT' only if the setup is a high-probability A+ trade. Otherwise, respond with 'WATCH' and explain the flaw in the setup.

        [SELF-LEARNING MEMORY]:
        ${learningContext}

        [ASSET]: ${id} | PRICE: ${currentPrices[id]}
        [FLOW_REPORT]: ${JSON.stringify(flowReport)}
        [STRUCTURE_REPORT]: ${JSON.stringify(structureReport)}
        [MACRO_REPORT]: ${JSON.stringify(macroReport)}
        [DERIVATIVES_REPORT]: ${JSON.stringify(derivativesReport)}
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
                if (e.message.includes('503') || e.message.includes('429')) {
                    // Экспоненциальное ожидание
                    const waitTime = Math.pow(attempt, 2) * 2000 + 1000;
                    console.log(`⚠️ [AI Engine]: Сервер Google перегружен. Попытка ${attempt}/${maxRetries} через ${waitTime/1000}с...`);
                    await new Promise(r => setTimeout(r, waitTime));
                } else {
                    console.error(`❌ [AI Error]: Ошибка Gemini API: ${e.message}`);
                    break; 
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
                console.error("🚨 РЕАЛЬНАЯ ОШИБКА ИИ:", e); // <--- ДОБАВЛЕН РЕНТГЕН-ЛОГ ДЛЯ ОТЛОВА ОШИБКИ
                broadcastHackerLog(`[System]: ИИ временно недоступен во всем регионе.`, 'ALERT');
                return; // Замок откроется в блоке finally
            }
        }

        try {
            const cleanJson = text.replace(/\x60\x60\x60json/g, '').replace(/\x60\x60\x60/g, '').trim();
            const verdicts = JSON.parse(cleanJson);

            for (const v of verdicts) {
                lastAiAnalysis[v.id] = Date.now();
                const plan = buildSignalPlan(v, safeNumber(currentPrices[v.id], 0), structureReport);
                await recordAIVerdict(v, plan);

                if (v.action === 'WATCH' || !v.action.includes('EXECUTE')) {
                    coinAiCooldowns[v.id] = Date.now() + 30 * 60 * 1000;
                    broadcastHackerLog(`[System]: ${v.id} отклонен ИИ. Заморозка на 30 мин.`, 'INFO');
                    continue;
                }

                if (plan.side && v.action.includes('EXECUTE') && v.confidence >= 85 && !activeMasterSignals[v.id]) { 
                    const detailedReason = `[${v.strategy || 'HYBRID'}] ${v.reason}`;
                    await createMasterSignal(v.id, currentPrices[v.id], plan.side, v.confidence, detailedReason, plan.tp, plan.sl, plan.rr);
                }
            }
        } catch (parseError) {
            console.error(`❌ [Parse Error]: Ошибка разбора ответа ИИ:`, parseError);
        }

    } finally {
        // 🔓 ОТКРЫВАЕМ ЗАМОК В ЛЮБОМ СЛУЧАЕ (после успеха или любой ошибки)
        isAiScanning = false;
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

// 🛡️ API ДЛЯ ПЕРЕДАЧИ ДАННЫХ И ПРОВЕРКИ ВЛАДЕЛЬЦА
app.get('/api/data', async (req, res) => {
    // АНТИ-КЭШ ДЛЯ ФИНАНСОВЫХ ДАННЫХ (Броня от Service Worker)
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });

    let isPrem = false; let userId = null; let isOwner = false;
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
                    
                    // 👑 ПРОВЕРКА НА ГЛАВНОГО АНАЛИТИКА (ВЛАДЕЛЬЦА)
                    if (user.email === 'JSculptor-TITAN' || user.email.includes('JSculptor-TITAN')) {
                        isOwner = true;
                    }
                }

                const statsData = isPrem ? await getPersonalStats() : { total: 0, winRate: 0 };
                const tradeHistory = isPrem ? await Trade.find().sort({ timestamp: -1 }).limit(10) : [];
                
                userCache[userId] = { isPrem, isOwner, statsData, tradeHistory, lastUpdate: now };
            } else {
                isPrem = userCache[userId].isPrem;
                isOwner = userCache[userId].isOwner || false;
            }
        } catch (e) {}
    }

    const statsData = isPrem && userId && userCache[userId] ? userCache[userId].statsData : { total: 0, winRate: 0 };
    const historyData = isPrem && userId && userCache[userId] ? userCache[userId].tradeHistory : [];
    const analyticsData = isPrem ? await getVerdictAnalytics() : null;
    const regimeData = updateMarketRegime();

    // Загружаем текущую Директиву для отображения в панели Владельца
    let currentDirective = "";
    if (isOwner) {
        try {
            const config = await MacroConfig.findOne({});
            if (config) currentDirective = config.directive;
        } catch(e) {}
    }

    const watchlist = Object.keys(orderFlowTracker)
        .map(id => ({
            id,
            score: orderFlowTracker[id].currentScore,
            reasons: orderFlowTracker[id].scoreDetails,
            fundingRate: orderFlowTracker[id].fundingRate,
            openInterestValue: orderFlowTracker[id].openInterestValue
        }))
        .sort((a, b) => b.score - a.score).slice(0, 10);

    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? Object.values(activeMasterSignals) : [], 
        tradeHistory: historyData, 
        stats: statsData, 
        premium: isPrem, 
        isOwner: isOwner, 
        macroDirective: currentDirective,
        orderFlow: orderFlowTracker,
        watchlist: watchlist,
        marketRegime: regimeData,
        analytics: analyticsData
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

// 👑 СЕКРЕТНЫЙ API ТОЛЬКО ДЛЯ ВЛАДЕЛЬЦА (Обновление Директивы)
app.post('/api/admin/update-directive', async (req, res) => {
    try {
        const { token, directive } = req.body;
        const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
        const user = await User.findById(decoded.id);
        
        // 🛡️ СТРОЖАЙШИЙ ЗАКОН: Доступ ИСКЛЮЧИТЕЛЬНО для аккаунта JSculptor-TITAN
        if (!user || (!user.email.includes('JSculptor-TITAN') && user.email !== 'JSculptor-TITAN')) {
            return res.status(403).json({ error: "Access Denied. Chief Analyst Only." });
        }

        await MacroConfig.findOneAndUpdate({}, 
            { directive: directive, updatedBy: user.email, updatedAt: Date.now() }, 
            { upsert: true, new: true }
        );
        
        res.json({ message: "Macro Directive updated successfully!" });
    } catch (e) { 
        res.status(401).send(); 
    }
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