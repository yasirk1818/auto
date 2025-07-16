// --- Imports ---
require('dotenv').config();
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

// --- Helper Functions ---
const readDeviceConfig = async () => {
    try {
        const data = await fs.readFile(DEVICES_CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return {};
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
    secret: 'auto-read-feature-is-the-best-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });

// --- All API Routes ---
// Auth Routes...
app.post('/login', (req, res) => { /* ... pehle jaisa hi ... */ });
app.get('/logout', (req, res) => { /* ... pehle jaisa hi ... */ });
app.get('/api/auth-status', (req, res) => { /* ... pehle jaisa hi ... */ });
// Yahan auth routes ka poora code daal dein
app.post('/login', (req, res) => {
    if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true; res.json({ success: true });
    } else { res.status(401).json({ success: false, message: 'Invalid Credentials' }); }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/auth-status', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));

// Device Routes...
app.get('/api/devices', checkAuth, async (req, res) => {
    const config = await readDeviceConfig();
    const deviceList = Object.keys(config).map(clientId => ({
        id: clientId,
        status: clientStatuses[clientId] || 'Disconnected',
        geminiEnabled: config[clientId].geminiEnabled || false,
        autoReadEnabled: config[clientId].autoReadEnabled || false // NAYA: autoRead status bhejein
    }));
    res.json(deviceList);
});

app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => { /* ... pehle jaisa hi ... */ });
app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => {
    const client = clients[req.params.clientId];
    if (client) { await client.logout(); res.json({ success: true }); }
    else { res.status(404).json({ success: false }); }
});


app.post('/api/toggle-gemini/:clientId', checkAuth, async (req, res) => { /* ... pehle jaisa hi ... */ });
app.post('/api/toggle-gemini/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readDeviceConfig();
    if (config[clientId]) {
        config[clientId].geminiEnabled = !config[clientId].geminiEnabled;
        await writeDeviceConfig(config);
        res.json({ success: true, geminiEnabled: config[clientId].geminiEnabled });
    } else { res.status(404).send('Device not found'); }
});


// NAYA: API to toggle auto-read
app.post('/api/toggle-autoread/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readDeviceConfig();
    if (config[clientId]) {
        config[clientId].autoReadEnabled = !config[clientId].autoReadEnabled;
        await writeDeviceConfig(config);
        res.json({ success: true, autoReadEnabled: config[clientId].autoReadEnabled });
    } else {
        res.status(404).send('Device not found');
    }
});

// Keyword Routes...
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => { /* ... pehle jaisa hi ... */ });
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => { /* ... pehle jaisa hi ... */ });
app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => { /* ... pehle jaisa hi ... */ });
// Yahan keywords API ka poora code daal dein
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const config = await readDeviceConfig();
    res.json(config[req.params.clientId]?.keywords || []);
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


// --- WhatsApp Client Logic ---
const initializeClient = async (clientId) => {
    if (clients[clientId]) return;
    clientStatuses[clientId] = 'Initializing';
    io.emit('statusUpdate', { clientId, status: 'Initializing' });

    const config = await readDeviceConfig();
    if (!config[clientId]) {
        // NAYA: Default settings for new device
        config[clientId] = {
            geminiEnabled: false,
            autoReadEnabled: false,
            keywords: []
        };
        await writeDeviceConfig(config);
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => { /* ... pehle jaisa hi ... */ });
    client.on('ready', () => { /* ... pehle jaisa hi ... */ });
    client.on('disconnected', (reason) => { /* ... pehle jaisa hi ... */ });
    // Poore event handlers
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


    // === MESSAGE HANDLER UPDATE FOR AUTO-READ ===
    client.on('message', async message => {
        const config = await readDeviceConfig();
        const deviceConfig = config[clientId];
        if (!deviceConfig) return;

        // 1. Auto Read Logic (Sabse pehle chalega)
        if (deviceConfig.autoReadEnabled) {
            try {
                const chat = await message.getChat();
                await chat.sendSeen();
                console.log(`[${clientId}] Marked message from ${message.from} as read.`);
            } catch (e) {
                console.error(`[${clientId}] Failed to mark as read:`, e);
            }
        }
        
        // 2. Keyword Check
        const incomingMessage = message.body.toLowerCase();
        for (const item of deviceConfig.keywords) {
            const keyword = item.keyword.toLowerCase();
            if ((item.match_type === 'exact' && incomingMessage === keyword) || (item.match_type === 'contains' && incomingMessage.includes(keyword))) {
                message.reply(item.reply);
                return;
            }
        }

        // 3. Gemini Check
        if (deviceConfig.geminiEnabled) {
            try {
                const result = await geminiModel.generateContent(message.body);
                const response = await result.response;
                const text = response.text();
                message.reply(text);
            } catch (error) {
                console.error(`[${clientId}] Gemini API Error:`, error);
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
io.on('connection', socket => { /* ... pehle jaisa hi ... */ });
const reinitializeExistingSessions = async () => { /* ... pehle jaisa hi ... */ };
server.listen(port, () => { /* ... pehle jaisa hi ... */ });
// Poora code
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
    console.log(`Server with AutoRead & Gemini support running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
