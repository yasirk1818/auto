// --- Imports ---
require('dotenv').config(); // .env file ko load karne ke liye sabse upar
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const port = 3000;
const clients = {};
const clientStatuses = {};
const DEVICES_CONFIG_PATH = path.join(__dirname, 'devices.json');

// --- Gemini AI Setup ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Helper Functions to read/write device config ---
const readDeviceConfig = async () => {
    try {
        const data = await fs.readFile(DEVICES_CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return {}; // File nahi hai to empty object
        throw error;
    }
};
const writeDeviceConfig = async (config) => {
    await fs.writeFile(DEVICES_CONFIG_PATH, JSON.stringify(config, null, 2));
};

// --- Credentials & Middlewares ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";
app.use(express.static('public'));
app.use(express.json());
app.use(session({
    secret: 'gemini-is-awesome-and-this-is-a-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });

// --- All API Routes (Auth, Device, Keywords, Gemini) ---
// ... (Auth routes pehle jaisa hi)
app.post('/login', (req, res) => { /* ... */ });
app.get('/logout', (req, res) => { /* ... */ });
app.get('/api/auth-status', (req, res) => { /* ... */ });
// Yahan auth routes ka poora code daal dein
app.post('/login', (req, res) => {
    if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true; res.json({ success: true });
    } else { res.status(401).json({ success: false, message: 'Invalid Credentials' }); }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/auth-status', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));


app.get('/api/devices', checkAuth, async (req, res) => {
    const config = await readDeviceConfig();
    const deviceList = Object.keys(config).map(clientId => ({
        id: clientId,
        status: clientStatuses[clientId] || 'Disconnected',
        geminiEnabled: config[clientId].geminiEnabled || false
    }));
    res.json(deviceList);
});

app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => { /* ... (Pehle jaisa hi) ... */ });
app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => {
    const client = clients[req.params.clientId];
    if (client) { await client.logout(); res.json({ success: true }); }
    else { res.status(404).json({ success: false }); }
});


// NAYA: Gemini Toggle API
app.post('/api/toggle-gemini/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readDeviceConfig();
    if (config[clientId]) {
        config[clientId].geminiEnabled = !config[clientId].geminiEnabled;
        await writeDeviceConfig(config);
        res.json({ success: true, geminiEnabled: config[clientId].geminiEnabled });
    } else {
        res.status(404).send('Device not found');
    }
});

// Keyword APIs (Updated to use new data structure)
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const config = await readDeviceConfig();
    const deviceConfig = config[req.params.clientId];
    res.json(deviceConfig ? deviceConfig.keywords : []);
});

app.post('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readDeviceConfig();
    if (!config[clientId]) return res.status(404).send('Device not found');
    const newKeyword = { id: Date.now(), ...req.body };
    config[clientId].keywords.push(newKeyword);
    await writeDeviceConfig(config);
    res.status(201).json(newKeyword);
});

app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => {
    const { clientId, keywordId } = req.params;
    const config = await readDeviceConfig();
    if (!config[clientId]) return res.status(404).send('Device not found');
    config[clientId].keywords = config[clientId].keywords.filter(k => k.id != keywordId);
    await writeDeviceConfig(config);
    res.status(204).send();
});


// --- WhatsApp Client Logic (Updated for Gemini) ---
const initializeClient = async (clientId) => {
    if (clients[clientId]) return;
    clientStatuses[clientId] = 'Initializing';
    io.emit('statusUpdate', { clientId, status: 'Initializing' });

    // Ensure config exists for this new device
    const config = await readDeviceConfig();
    if (!config[clientId]) {
        config[clientId] = { geminiEnabled: false, keywords: [] };
        await writeDeviceConfig(config);
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => { /* ... pehle jaisa hi ... */ });
    client.on('ready', () => { /* ... pehle jaisa hi ... */ });
    client.on('disconnected', (reason) => { /* ... pehle jaisa hi ... */ });
    // Full event handlers
    client.on('qr', qr => {
        clientStatuses[clientId] = 'Needs QR Scan';
        io.emit('statusUpdate', { clientId, status: 'Needs QR Scan' });
        qrcode.toDataURL(qr, (err, url) => { if (!err) io.emit('qr', { clientId, url }); });
    });
    client.on('ready', () => {
        clientStatuses[clientId] = 'Connected';
        io.emit('statusUpdate', { clientId, status: 'Connected' });
    });
    client.on('disconnected', (reason) => {
        clientStatuses[clientId] = 'Disconnected';
        io.emit('statusUpdate', { clientId, status: 'Disconnected' });
        delete clients[clientId];
    });


    // === MESSAGE HANDLER UPDATE FOR GEMINI ===
    client.on('message', async message => {
        const config = await readDeviceConfig();
        const deviceConfig = config[clientId];
        if (!deviceConfig) return;

        const incomingMessage = message.body.toLowerCase();

        // 1. Keyword Check (Priority 1)
        for (const item of deviceConfig.keywords) {
            const keyword = item.keyword.toLowerCase();
            if ((item.match_type === 'exact' && incomingMessage === keyword) || (item.match_type === 'contains' && incomingMessage.includes(keyword))) {
                console.log(`[${clientId}] Matched keyword: "${keyword}". Replying...`);
                message.reply(item.reply);
                return; // Stop processing
            }
        }

        // 2. Gemini Check (Priority 2)
        if (deviceConfig.geminiEnabled) {
            console.log(`[${clientId}] No keyword match. Forwarding to Gemini...`);
            try {
                const result = await geminiModel.generateContent(message.body);
                const response = await result.response;
                const text = response.text();
                console.log(`[${clientId}] Gemini replied: "${text}"`);
                message.reply(text);
            } catch (error) {
                console.error(`[${clientId}] Gemini API Error:`, error);
                // Optionally send a fallback message
                // message.reply("Sorry, I'm having trouble thinking right now. Please try again later.");
            }
        }
    });

    client.initialize().catch(err => {
        console.error(`Initialization failed for ${clientId}:`, err);
        clientStatuses[clientId] = 'Failed';
        io.emit('statusUpdate', { clientId, status: 'Failed' });
    });
    clients[clientId] = client;
};


// --- Socket.IO & Server Startup ---
io.on('connection', socket => {
    socket.on('add-device', ({ clientId }) => {
        const cleanClientId = clientId.replace(/\s+/g, '_');
        if (cleanClientId) initializeClient(cleanClientId);
    });
});
const reinitializeExistingSessions = async () => {
    const config = await readDeviceConfig();
    Object.keys(config).forEach(clientId => initializeClient(clientId));
};
server.listen(port, () => {
    console.log(`Server with Gemini support running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
