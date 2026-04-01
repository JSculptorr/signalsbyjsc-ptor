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

// Раздача главной страницы
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- НАСТРОЙКИ БАЗЫ ДАННЫХ ---
const MONGO_URI = "mongodb+srv://alforss23_db_user:Azamat0444@cluster0.6visao7.mongodb.net/jsculptor?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Connection Error:", err));

// --- МОДЕЛИ ДАННЫХ ---
const UserSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    subscriptionStatus: { type: String, default: "inactive" },
    subscriptionExpires: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const CodeSchema = new mongoose.Schema({
    code: { type: String, unique: true },
    days: { type: Number, default: 30 },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});
const Code = mongoose.model('Code', CodeSchema);

// --- ЛОГИКА ТОРГОВОГО РОБОТА ---
let lastPrice = 0;
let activeSignals = [];
let tradeHistory = [];
let stats = { total: 154, wins: 128, losses: 26, winRate: 83 };

function updateSignalsAndHistory() {
    // Активный сигнал (генерируется на основе живой цены)
    activeSignals = [
        { 
            pair: "BTC/USDT", 
            type: "BUY", 
            entry: lastPrice || 68000, 
            tp: (lastPrice * 1.012).toFixed(2), 
            sl: (lastPrice * 0.992).toFixed(2), 
            time: "Live Now",
            status: "active" 
        }
    ];

    // История сделок
    tradeHistory = [
        { pair: "BTC/USDT", type: "BUY", entry: "67100.50", tp: "+2.14%", time: "2h ago", status: "win" },
        { pair: "ETH/USDT", type: "SELL", entry: "3540.20", tp: "+1.85%", time: "5h ago", status: "win" },
        { pair: "SOL/USDT", type: "BUY", entry: "145.10", tp: "-0.50%", time: "Yesterday", status: "loss" }
    ];
}

async function updateMarketData() {
    try {
        const response = await axios.get('https://api.coinbase.com/v2/prices/BTC-USDT/spot');
        lastPrice = parseFloat(response.data.data.amount);
        updateSignalsAndHistory();
    } catch (e) { console.error("Market Data Error"); }
}

setInterval(updateMarketData, 30000);
updateMarketData();

// --- ЭНДПОИНТЫ АВТОРИЗАЦИИ ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ email, password: hashedPassword });
        await user.save();
        res.json({ message: "Success" });
    } catch (e) { res.status(400).json({ error: "Email already exists" }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign({ id: user._id }, JWT_SECRET);
            res.json({ token, email: user.email });
        } else {
            res.status(401).json({ error: "Wrong credentials" });
        }
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// --- ЛОГИКА ПОДПИСКИ ---
app.post('/api/activate', async (req, res) => {
    const { token, codeStr } = req.body;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const codeDoc = await Code.findOne({ code: codeStr, isUsed: false });
        if (!codeDoc) return res.status(404).json({ error: "Invalid or used code" });

        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + codeDoc.days);

        await User.findByIdAndUpdate(decoded.id, {
            subscriptionStatus: "active",
            subscriptionExpires: expireDate
        });

        codeDoc.isUsed = true;
        codeDoc.usedBy = decoded.id;
        await codeDoc.save();

        res.json({ message: "Activated!", expires: expireDate });
    } catch (e) { res.status(401).json({ error: "Auth failed" }); }
});

// --- ГЛАВНЫЙ API (Выдача данных) ---
app.get('/api/data', async (req, res) => {
    const authHeader = req.headers.authorization;
    let isPremium = false;

    if (authHeader && authHeader !== 'Bearer null') {
        try {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.id);
            if (user && user.subscriptionExpires && user.subscriptionExpires > new Date()) {
                isPremium = true;
            }
        } catch (e) { console.log("Auth error in /api/data"); }
    }

    // Обработка Активных сигналов (скрываем цены, если нет премиума)
    const safeActive = activeSignals.map((s) => {
        if (!isPremium) {
            return { ...s, entry: "LOCKED", tp: "LOCKED", sl: "LOCKED", blur: true };
        }
        return s;
    });

    // Обработка Истории (если нет премиума — массив пустой)
    const safeHistory = isPremium ? tradeHistory : [];

    res.json({ 
        price: lastPrice, 
        activeSignals: safeActive, 
        tradeHistory: safeHistory, 
        stats: stats, 
        premium: isPremium 
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));