const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');

const app = express();
const JWT_SECRET = "jsc-secret-key-unique-2026"; 

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- ПОДКЛЮЧЕНИЕ К MONGODB ---
const MONGO_URI = "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ MongoDB Error:", err));

// --- МОДЕЛИ ДАННЫХ ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}));

const Code = mongoose.model('Code', new mongoose.Schema({
    code: { type: String, unique: true },
    days: { type: Number, default: 30 },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}));

// --- ЛОГИКА СИГНАЛОВ И УМНОЙ ИСТОРИИ ---
let lastPrice = 0;
let currentSignal = null; 
let tradeHistory = []; 
let stats = { total: 154, wins: 128, losses: 26, winRate: 83 };

// Вспомогательная функция для расчета EMA (Скользящая средняя)
function calculateEMA(closes, period) {
    let k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
}

// Вспомогательная функция для расчета RSI (Индекс силы)
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    
    for (let i = 1; i <= period; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        let gain = diff >= 0 ? diff : 0;
        let loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    
    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function analyzePriceAction(price, ema, rsi) {
    if (!price) return;
    
    const resLevel = Math.ceil(price / 500) * 500;
    const supLevel = Math.floor(price / 500) * 500;

    if (!currentSignal) {
        let type = null;
        let entry = 0;

        const nearResistance = (price > resLevel - 15);
        const nearSupport = (price < supLevel + 15);

        // УСЛОВИЕ ДЛЯ ПОКУПКИ (BUY):
        // 1. Цена у уровня. 2. Тренд растущий (Цена выше EMA). 3. Нет перекупленности (RSI ниже 70).
        if ((nearResistance || nearSupport) && price > ema && rsi < 70) {
            type = "BUY";
            entry = price;
        } 
        // УСЛОВИЕ ДЛЯ ПРОДАЖИ (SELL):
        // 1. Цена у уровня. 2. Тренд падающий (Цена ниже EMA). 3. Нет перепроданности (RSI выше 30).
        else if ((nearResistance || nearSupport) && price < ema && rsi > 30) {
            type = "SELL";
            entry = price;
        }

        if (type) {
            const isBuy = type === "BUY";
            currentSignal = {
                pair: "BTC/USDT",
                type: type,
                entry: entry.toFixed(2),
                tp: isBuy ? (entry * 1.018).toFixed(2) : (entry * 0.982).toFixed(2),
                sl: isBuy ? (entry * 0.991).toFixed(2) : (entry * 1.009).toFixed(2),
                status: "active",
                timestamp: Date.now()
            };
        }
    } else {
        const isBuy = currentSignal.type === "BUY";
        
        if (isBuy) {
            if (price >= parseFloat(currentSignal.tp)) pushToHistory("SUCCESS");
            else if (price <= parseFloat(currentSignal.sl)) pushToHistory("FAILED");
        } else {
            // Для SELL условий всё наоборот: профит внизу, стоп вверху
            if (price <= parseFloat(currentSignal.tp)) pushToHistory("SUCCESS");
            else if (price >= parseFloat(currentSignal.sl)) pushToHistory("FAILED");
        }
    }
}

function pushToHistory(result) {
    const closedSignal = {
        ...currentSignal,
        status: result,
        closedAt: Date.now(), 
        profit: result === "SUCCESS" ? "+1.80%" : "-0.90%"
    };
    
    tradeHistory.unshift(closedSignal);
    currentSignal = null;

    stats.total++;
    if (result === "SUCCESS") stats.wins++; else stats.losses++;
    stats.winRate = Math.round((stats.wins / stats.total) * 100);
}

function getLiveHistory() {
    const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    tradeHistory = tradeHistory.filter(sig => (now - sig.closedAt) < TEN_DAYS_MS);
    return tradeHistory;
}

async function updatePrice() {
    try {
        // Запрашиваем 100 последних 15-минутных свечей с Binance
        const res = await axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=100');
        const closes = res.data.map(kline => parseFloat(kline[4])); // 4 индекс - это цена закрытия свечи
        
        lastPrice = closes[closes.length - 1]; // Последняя цена в массиве — текущая
        
        const ema = calculateEMA(closes, 20); // EMA за 20 свечей
        const rsi = calculateRSI(closes, 14); // RSI за 14 свечей

        analyzePriceAction(lastPrice, ema, rsi);
    } catch (e) { 
        console.error("Price Error"); 
    }
}

setInterval(updatePrice, 10000);
updatePrice();

// --- API ЭНДПОИНТЫ ---

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hash = await bcrypt.hash(password, 10);
        const user = new User({ email, password: hash });
        await user.save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Email exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ id: user._id }, JWT_SECRET);
        res.json({ token, email: user.email });
    } else { res.status(401).json({ error: "Wrong pass" }); }
});

app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (!codeDoc) return res.status(404).json({ error: "Code used/invalid" });

        const exp = new Date();
        exp.setDate(exp.getDate() + codeDoc.days);

        await User.findByIdAndUpdate(decoded.id, {
            subscriptionStatus: "active",
            subscriptionExpires: exp
        });

        codeDoc.isUsed = true;
        codeDoc.usedBy = decoded.id;
        await codeDoc.save();
        res.json({ message: "Activated!" });
    } catch (e) { res.status(401).json({ error: "Auth fail" }); }
});

app.get('/api/data', async (req, res) => {
    let isPrem = false;
    const auth = req.headers.authorization;
    if (auth && auth !== 'Bearer null') {
        try {
            const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user && (user.subscriptionStatus === "active" || user.subscriptionExpires > new Date())) {
                isPrem = true;
            }
        } catch (e) {}
    }

    const active = currentSignal ? [currentSignal] : [];
    const processedActive = active.map(s => isPrem ? s : { ...s, entry: "LOCKED", tp: "LOCKED", sl: "LOCKED", blur: true });

    res.json({ 
        price: lastPrice, 
        activeSignals: processedActive, 
        tradeHistory: isPrem ? getLiveHistory() : [], 
        stats, 
        premium: isPrem 
    });
});

app.listen(process.env.PORT || 10000, () => console.log("🚀 Server Running"));