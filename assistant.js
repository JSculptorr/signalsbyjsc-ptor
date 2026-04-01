const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const { RSI, EMA } = require('technicalindicators');

const app = express();
const JWT_SECRET = "jsc-secret-key-unique-2026"; // ДОБАВИЛИ ЭТУ СТРОКУ

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
    subscription_status: { type: String, default: "inactive" },
    subscription_expires_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const CodeSchema = new mongoose.Schema({
    code: { type: String, unique: true },
    days: { type: Number, default: 30 },
    is_used: { type: Boolean, default: false },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});
const Code = mongoose.model('Code', CodeSchema);

// --- ЛОГИКА ТОРГОВОГО РОБОТА ---
let lastPrice = 0;
let signals = [];
let stats = { total: 0, wins: 0, losses: 0, winRate: 0 };

async function updateMarketData() {
    try {
        const response = await axios.get('https://api.coinbase.com/v2/prices/BTC-USDT/spot');
        lastPrice = parseFloat(response.data.data.amount);
    } catch (e) { console.error("Market Data Error"); }
}
setInterval(updateMarketData, 30000);

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
        const codeDoc = await Code.findOne({ code: codeStr, is_used: false });
        
        if (!codeDoc) return res.status(404).json({ error: "Invalid or used code" });

        const expireDate = new Date();
        expireDate.setDate(expireDate.getDate() + codeDoc.days);

        await User.findByIdAndUpdate(decoded.id, {
            subscription_status: "active",
            subscription_expires_at: expireDate
        });

        codeDoc.is_used = true;
        codeDoc.user_id = decoded.id;
        await codeDoc.save();

        res.json({ message: "Activated!", expires: expireDate });
    } catch (e) { res.status(401).json({ error: "Auth failed" }); }
});

// --- ГЛАВНЫЙ API ВЫДАЧИ ДАННЫХ ---
app.get('/api/data', async (req, res) => {
    const authHeader = req.headers.authorization;
    let isPremium = false;

    if (authHeader) {
        try {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await User.findById(decoded.id);
            
            if (user && user.subscription_expires_at > new Date()) {
                isPremium = true;
            } else if (user) {
                user.subscription_status = "inactive";
                await user.save();
            }
        } catch (e) {}
    }

    const safeSignals = signals.map((s, index) => {
        if (!isPremium && index > 0) {
            return { ...s, entry: "LOCKED", tp: "LOCKED", sl: "LOCKED", blur: true };
        }
        return s;
    });

    res.json({ price: lastPrice, signals: safeSignals, stats: stats, premium: isPremium });
});

// --- АДМИНКА ---
app.post('/api/admin/gen', async (req, res) => {
    const secret = req.headers['admin-key'];
    if (secret !== "jsc-boss-2026") return res.sendStatus(403);

    const newCodeStr = "JSC-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    const code = new Code({ code: newCodeStr, days: 30 });
    await code.save();
    res.json({ code: newCodeStr });
});

const PORT = process.env.PORT || 10000; // На Render стандартный порт 10000
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));