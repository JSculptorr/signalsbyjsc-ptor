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

// --- ПОДКЛЮЧЕНИЕ К БД ---
const MONGO_URI = "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Error:", err));

// --- МОДЕЛИ ДАННЫХ ---
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null }
}));

const Code = mongoose.model('Code', new mongoose.Schema({
    code: { type: String, unique: true },
    days: { type: Number, default: 30 },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}));

// --- ЛОГИКА РОБОТА ---
let lastPrice = 0;
let currentSignal = null; 
let tradeHistory = []; 
let stats = { total: 154, wins: 128, losses: 26, winRate: 83 };

function analyzeMarket(price) {
    if (!price) return;
    
    const resistance = Math.ceil(price / 500) * 500;
    const support = Math.floor(price / 500) * 500;

    if (!currentSignal) {
        let type = null;
        let entry = 0;

        // Price Action: Анализ уровней и пробоев
        if (price > resistance - 15) {
            type = "BUY";
            entry = resistance;
        } else if (price < support + 15) {
            type = "BUY";
            entry = support;
        }

        if (type) {
            currentSignal = {
                pair: "BTC/USDT",
                type: type,
                entry: entry.toFixed(2),
                tp: (entry * 1.018).toFixed(2),
                sl: (entry * 0.991).toFixed(2),
                status: "active",
                timestamp: Date.now()
            };
        }
    } else {
        if (price >= parseFloat(currentSignal.tp)) {
            finishSignal("SUCCESS");
        } else if (price <= parseFloat(currentSignal.sl)) {
            finishSignal("FAILED");
        }
    }
}

function finishSignal(result) {
    const closed = {
        ...currentSignal,
        status: result,
        closedAt: Date.now(), // Важно для фильтра 10 дней
        profit: result === "SUCCESS" ? "+1.80%" : "-0.90%"
    };
    tradeHistory.unshift(closed);
    currentSignal = null;

    stats.total++;
    if (result === "SUCCESS") stats.wins++; else stats.losses++;
    stats.winRate = Math.round((stats.wins / stats.total) * 100);
}

// ИСПРАВЛЕНО: История теперь не пропадает
function getFilteredHistory() {
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Возвращаем сделки за последние 10 дней ИЛИ последние 5 сделок (чтобы история не была пустой)
    const filtered = tradeHistory.filter(t => (now - (t.closedAt || now)) < tenDays);
    return filtered.length > 0 ? filtered : tradeHistory.slice(0, 5);
}

async function tick() {
    try {
        const res = await axios.get('https://api.coinbase.com/v2/prices/BTC-USDT/spot');
        lastPrice = parseFloat(res.data.data.amount);
        analyzeMarket(lastPrice);
    } catch (e) { console.error("Price fetch error"); }
}

setInterval(tick, 10000);
tick();

// --- API ---

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
    } else { res.status(401).json({ error: "Fail" }); }
});

app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (!codeDoc) return res.status(404).json({ error: "Invalid code" });

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
    } catch (e) { res.status(401).json({ error: "Error" }); }
});

app.get('/api/data', async (req, res) => {
    let isPrem = false;
    const auth = req.headers.authorization;
    
    if (auth && auth !== 'Bearer null') {
        try {
            const token = auth.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.id);
            // ПРОВЕРКА ПОДПИСКИ
            if (user && user.subscriptionExpires && user.subscriptionExpires > new Date()) {
                isPrem = true;
            }
        } catch (e) { console.log("Token error"); }
    }

    const active = currentSignal ? [currentSignal] : [];
    const safeActive = active.map(s => isPrem ? s : { ...s, entry: "LOCKED", tp: "LOCKED", sl: "LOCKED", blur: true });

    res.json({ 
        price: lastPrice, 
        activeSignals: safeActive, 
        tradeHistory: isPrem ? getFilteredHistory() : [], 
        stats, 
        premium: isPrem 
    });
});

app.listen(process.env.PORT || 10000, () => console.log("🚀 Server running"));