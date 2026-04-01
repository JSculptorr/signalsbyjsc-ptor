const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const { RSI, EMA } = require('technicalindicators');

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
let signals = [];
let stats = { total: 154, wins: 128, losses: 26, winRate: 83 };

// Функция для генерации тестовых сигналов (потом заменим на логику RSI)
function generateSignals() {
    signals = [
        { pair: "BTC/USDT", type: "BUY", entry: lastPrice || 65000, tp: (lastPrice * 1.02).toFixed(2), sl: (lastPrice * 0.98).toFixed(2), time: "Active" },
        { pair: "ETH/USDT", type: "SELL", entry: 3500, tp: 3400, sl: 3550, time: "2h ago" }
    ];
}

async function updateMarketData() {
    try {
        const response = await axios.get('https://api.coinbase.com/v2/prices/BTC-USDT/spot');
        lastPrice = parseFloat(response.data.data.amount);
        generateSignals(); // Обновляем сигналы при обновлении цены
    } catch (e) { console.error("Market Data Error"); }
}
setInterval(updateMarketData, 30000);
updateMarketData(); // Первый запуск сразу

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

// --- ЛОГИКА ПОДПИСКИ И КОДОВ ---
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

// --- ГЛАВНЫЙ API ВЫДАЧИ ДАННЫХ ---
app.get('/api/data', async (req, res) => {
    const authHeader = req.headers.authorization;
    let isPremium = false;

    if (authHeader && authHeader !== 'null') {
        try {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.id);
            
            if (user && user.subscriptionExpires && user.subscriptionExpires > new Date()) {
                isPremium = true;
            } else if (user && user.subscriptionStatus === "active") {
                user.subscriptionStatus = "inactive";
                await user.save();
            }
        } catch (e) { console.log("Auth check error"); }
    }

    const safeSignals = signals.map((s, index) => {
        // Первый сигнал бесплатный, остальные под замком для No-Premium
        if (!isPremium && index > 0) {
            return { ...s, entry: "LOCKED", tp: "LOCKED", sl: "LOCKED", blur: true };
        }
        return s;
    });

    res.json({ price: lastPrice, signals: safeSignals, stats: stats, premium: isPremium });
});

// --- АДМИНКА (Генерация кодов) ---
app.post('/api/admin/gen', async (req, res) => {
    const secret = req.headers['admin-key'];
    if (secret !== "jsc-boss-2026") return res.sendStatus(403);

    const newCodeStr = "JSC-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    const code = new Code({ code: newCodeStr, days: 30 });
    await code.save();
    res.json({ code: newCodeStr });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));