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

// --- INSTITUTIONAL ENCRYPTION SYSTEM ---
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

// --- VAPID PUSH NOTIFICATIONS ---
const VAPID_PUBLIC = "BO9C6q4TYaPHwA9_J-lNlqVk4IzPo44_96Mr2TjOXnDMp7GvxtTNXwlLEH6wj2jhRe_LOBjKGns1Hjc13oxTJFM";
const VAPID_PRIVATE = "YDw21D-BLvlwsawyHi59tqLoG4oCqnK7X96ND0z04W8";
webpush.setVapidDetails('mailto:support@jsculptor.com', VAPID_PUBLIC, VAPID_PRIVATE);

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- MONGODB CLUSTER CONNECTION ---
const MONGO_URI = "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0";
const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI, { 
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000 
        });
        console.log("✅ [SUCCESS]: Matrix Institutional Engine v7.5 Loaded");
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
    coinId: String, pair: String, type: String, entry: Number, sl: Number, tp: Number,
    size: Number, partialHit: { type: Boolean, default: false }, 
    desc: String, confidence: Number, grade: String, timeLabel: String,
    timestamp: { type: Date, default: Date.now }
}));

const Trade = mongoose.model('Trade', new mongoose.Schema({
    pair: String, type: String, entry: Number, exit: Number, sl: Number, tp: Number,
    result: String, profitCash: Number, rr: Number, grade: String, timestamp: { type: Date, default: Date.now }
}));

// --- GLOBAL ASSETS (24 COINS) ---
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
        htfHigh: 0, htfLow: 0, lastOI: 0, volumePOC: 0, 
        intensity: 0, sweptAt: 0, waitingForBOS: false, dailyBias: 'SIDEWAYS' 
    };
});

let tradeHistory = []; 
let stats = { total: 0, wins: 0, losses: 0, winRate: 0, maxDrawdown: 0, avgRR: 0, streak: 0 };

// --- HACKER LOG BROADCAST ---
function broadcastHackerLog(msg, type = 'INFO') {
    const time = new Date().toLocaleTimeString();
    const icons = { INFO: '📡', SWEEP: '🚨', BOS: '⚡', ENTRY: '🎯', ERROR: '⚠️', INSTITUTIONAL: '🏦' };
    io.emit('hacker_log', `[${time}] ${icons[type] || ''} ${msg}`);
}

async function syncWithDatabase() {
    try {
        const dbActive = await ActiveSignal.find();
        dbActive.forEach(sig => { activeSignals[sig.coinId] = { ...sig._doc, status: "active" }; });
        tradeHistory = await Trade.find().sort({ timestamp: -1 }).limit(20);
        await calculateMetrics();
    } catch (e) { console.error("Sync Error:", e); }
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

// --- GUARANTEED LIVE PRICES (SPOT TICKER) ---
async function updateLivePrices() {
    try {
        const res = await axios.get('https://api.binance.com/api/v3/ticker/price');
        const data = res.data;
        ASSETS.forEach(asset => {
            const pair = data.find(p => p.symbol === asset.symbol);
            if (pair) currentPrices[asset.id] = parseFloat(pair.price);
        });
    } catch (e) { /* Fail silently to keep log clean */ }
}

// --- MATRIX ENGINE: HEATMAP + BOS SMC LOGIC ---
async function processSurgicalRadar() {
    const hour = new Date().getUTCHours();
    // Kill Zones: London & New York
    const isKillZone = (hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 16);

    for (const coin of ASSETS) {
        try {
            const resPrice = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=1m&limit=10`);
            const resOI = await axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`);
            
            const ticks = resPrice.data;
            const price = parseFloat(ticks[ticks.length - 1][4]);
            const currentOI = parseFloat(resOI.data.openInterest);
            const struct = marketStructure[coin.id];

            // A. CALCULATE MATRIX INTENSITY (For Heatmap Glowing)
            const volume = parseFloat(ticks[ticks.length - 1][5]);
            const volRel = Math.min((volume / struct.volumePOC) * 45, 45);
            const oiDelta = Math.abs((currentOI - struct.lastOI) / struct.lastOI) * 1100;
            struct.intensity = Math.round(volRel + Math.min(oiDelta, 55));

            if (activeSignals[coin.id]) { 
                checkTradeExecution(coin, price); 
                continue; 
            }

            if (!isKillZone || struct.dailyBias === 'SIDEWAYS') continue;

            // B. LIQUIDITY SWEEP DETECTOR
            if (!struct.waitingForBOS) {
                if (price > struct.htfHigh && struct.htfHigh > 0) {
                    struct.waitingForBOS = 'SHORT'; struct.sweptAt = price;
                    broadcastHackerLog(`${coin.id}: Свип PDH. Ожидаю BOS подтверждения...`, 'SWEEP');
                } else if (price < struct.htfLow && struct.htfLow > 0) {
                    struct.waitingForBOS = 'LONG'; struct.sweptAt = price;
                    broadcastHackerLog(`${coin.id}: Свип PDL. Ожидаю BOS подтверждения...`, 'SWEEP');
                }
            }

            // C. BOS (BREAK OF STRUCTURE) DETECTOR
            if (struct.waitingForBOS) {
                const prevCandle = ticks[ticks.length - 2];
                const lastCandle = ticks[ticks.length - 1];
                const side = struct.waitingForBOS;
                
                let isBos = false;
                if (side === 'SHORT' && parseFloat(lastCandle[4]) < parseFloat(prevCandle[3])) isBos = true;
                if (side === 'LONG' && parseFloat(lastCandle[4]) > parseFloat(prevCandle[2])) isBos = true;

                if (isBos) {
                    // Smart Entry: 50% Equilibrium of the manipulation move
                    const smartEntry = (struct.sweptAt + price) / 2;
                    let conf = 75;
                    if (currentOI < struct.lastOI) conf += 15;
                    if (volume > struct.volumePOC * 1.8) conf += 10;
                    let grade = conf >= 90 ? 'A+' : (conf >= 85 ? 'A' : 'B');

                    await createSurgicalSignal(coin, smartEntry, side, conf, grade);
                    struct.waitingForBOS = false;
                }
            }
            struct.lastOI = currentOI;

        } catch (e) { /* Analysis error bypass */ }
    }
}

async function createSurgicalSignal(coin, entry, side, confidence, grade) {
    const slDist = entry * 0.005; 
    const sl = side === 'LONG' ? entry - slDist : entry + slDist;
    const tp = side === 'LONG' ? entry + slDist * 2 : entry - slDist * 2; 

    const timeLabel = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const newSig = new ActiveSignal({
        coinId: coin.id, pair: `${coin.id}/USDT`, 
        type: side === 'LONG' ? `🏦 ${coin.id} LONG` : `🏦 ${coin.id} SHORT`,
        entry, sl, tp, size: 100 / Math.abs(entry - sl),
        confidence, grade, timeLabel,
        desc: `MATRIX ENGINE v7.5 | SMART ENTRY`
    });
    
    await newSig.save();
    activeSignals[coin.id] = { ...newSig._doc, status: "active" };
    broadcastHackerLog(`🎯 MATRIX ENTRY: ${coin.id} ${side} @ ${entry.toFixed(4)} [Grade ${grade}]`, 'ENTRY');
    sendVipNotifications(coin.id, side, grade);
}

// --- DAILY HTF SYNC ---
async function updateHtfLevels() {
    for (const asset of ASSETS) {
        try {
            const res = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${asset.symbol}&interval=1d&limit=2`);
            const prevDay = res.data[0]; const struct = marketStructure[asset.id];
            
            struct.htfHigh = parseFloat(prevDay[2]); 
            struct.htfLow = parseFloat(prevDay[3]);  
            struct.volumePOC = parseFloat(prevDay[5]) / 1440;
            struct.dailyBias = (parseFloat(prevDay[4]) > parseFloat(prevDay[1])) ? 'UP' : 'DOWN';

            const resOI = await axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${asset.symbol}`);
            struct.lastOI = parseFloat(resOI.data.openInterest);
        } catch (e) { console.error(`HTF Sync failed for ${asset.id}`); }
    }
}

async function sendVipNotifications(coinId, side, grade) {
    try {
        const vipUsers = await User.find({ subscriptionStatus: "active" });
        const subscriptions = await PushSubscription.find({ userId: { $in: vipUsers.map(u => u._id) } });
        const payload = JSON.stringify({ title: `GRADE ${grade}: ${coinId}`, body: `Institutional Flow Detected: ${side}` });
        subscriptions.forEach(subDoc => webpush.sendNotification(subDoc.subscription, payload).catch(() => {}));
    } catch (err) {}
}

function checkTradeExecution(coin, price) {
    const sig = activeSignals[coin.id]; if (!sig) return;
    const entry = parseFloat(sig.entry), tp = parseFloat(sig.tp), isLong = sig.type.includes('LONG');
    
    // BE Adjustment
    const totalDist = Math.abs(tp - entry);
    const currentDist = Math.abs(price - entry);
    if ((currentDist / totalDist) >= 0.4 && !sig.partialHit) {
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
    const sig = activeSignals[coinId]; if (!sig) return;
    const entry = parseFloat(sig.entry); let profitCash = (exitPrice - entry) * sig.size;
    const rr = Math.abs(exitPrice - entry) / Math.abs(entry - parseFloat(sig.sl)) || 1;
    await new Trade({ pair: sig.pair, type: sig.type, entry, exit: exitPrice, sl: sig.sl, tp: sig.tp, result, profitCash, rr, grade: sig.grade }).save();
    await ActiveSignal.deleteOne({ _id: sig._id });
    await User.findOneAndUpdate({ subscriptionStatus: "active" }, { $inc: { balance: profitCash } });
    activeSignals[coinId] = null; await syncWithDatabase();
}

// --- API ENDPOINTS ---
app.get('/api/proxy/candles', async (req, res) => {
    const { symbol, interval, limit } = req.query;
    try {
        const response = await axios.get(`https://data-api.binance.vision/api/v3/klines`, {
            params: { symbol: symbol || 'BTCUSDT', interval: interval || '1h', limit: limit || 100 }
        });
        res.json(response.data);
    } catch (e) { res.status(500).json({ error: "External API Error" }); }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.password, 10);
        await new User({ email: req.body.email, password: hash }).save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Email already exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.body.email });
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            res.json({ token: jwt.sign({ id: user._id }, JWT_SECRET), email: user.email });
        } else res.status(401).json({ error: "Invalid credentials" });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (!codeDoc) return res.status(404).json({ error: "Code Invalid/Used" });
        const expDate = new Date(); expDate.setDate(expDate.getDate() + codeDoc.days);
        await User.findByIdAndUpdate(decoded.id, { subscriptionStatus: "active", subscriptionExpires: expDate });
        codeDoc.isUsed = true; codeDoc.usedBy = decoded.id; await codeDoc.save();
        res.json({ message: "Activated!" });
    } catch (e) { res.status(401).json({ error: "Auth Error" }); }
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
    res.json({ 
        prices: currentPrices, 
        activeSignals: isPrem ? active : [], 
        tradeHistory, 
        stats, 
        premium: isPrem, 
        radar: marketStructure 
    });
});

// --- TIMERS ---
setInterval(updateLivePrices, 5000); 
setInterval(processSurgicalRadar, 10000); 
updateHtfLevels();
setInterval(updateHtfLevels, 3600000); 

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(` >>> JSCULPTOR MATRIX v7.5 ONLINE <<< `);
    console.log(`=========================================`);
});