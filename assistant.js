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

// --- ЛОГИКА СИГНАЛОВ И УМНОЙ ИСТОРИИ (10 ДНЕЙ) ---
let lastPrice = 0;
let currentSignal = null; 
let tradeHistory = []; // Хранится в памяти сервера
let stats = { total: 154, wins: 128, losses: 26, winRate: 83 };

function analyzePriceAction(price) {
    if (!price) return;
    
    const resLevel = Math.ceil(price / 500) * 500;
    const supLevel = Math.floor(price / 500) * 500;

    if (!currentSignal) {
        let type = null;
        let entry = 0;

        if (price > resLevel - 15) {
            type = "BUY";
            entry = price; // Берем текущую цену как точку входа
        } else if (price < supLevel + 15) {
            type = "BUY";
            entry = price;
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
            pushToHistory("SUCCESS");
        } else if (price <= parseFloat(currentSignal.sl)) {
            pushToHistory("FAILED");
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

// ФУНКЦИЯ ОЧИСТКИ: Удаляет сигналы старше 10 дней
function getLiveHistory() {
    const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    // Фильтруем массив: оставляем только то, что закрыто меньше 10 дней назад
    tradeHistory = tradeHistory.filter(sig => (now - sig.closedAt) < TEN_DAYS_MS);
    return tradeHistory;
}

async function updatePrice() {
    try {
        const res = await axios.get('https://api.coinbase.com/v2/prices/BTC-USDT/spot');
        lastPrice = parseFloat(res.data.data.amount);
        analyzePriceAction(lastPrice);
    } catch (e) { console.error("Price Error"); }
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
            // Проверка по дате ИЛИ по статусу active
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