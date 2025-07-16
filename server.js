// --- Imports ---
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
const GLOBAL_CONFIG_PATH = path.join(__dirname, 'config.json'); // NAYA: Global config file

// --- Helper Functions ---
const readDeviceConfig = async () => { /* ... pehle jaisa hi ... */ };
const writeDeviceConfig = async (config) => { /* ... pehle jaisa hi ... */ };
const readGlobalConfig = async () => {
    try {
        const data = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (e) { return { geminiApiKey: "", geminiModelName: "gemini-1.0-pro" }; }
};
const writeGlobalConfig = async (config) => {
    await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
};

// --- Credentials & Middlewares ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";
// ... (saare middlewares pehle jaise hi)
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'this-is-the-final-secret-key-i-promise',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });


// --- API Routes ---
// Auth Routes
app.post('/login', (req, res) => { /* ... */ });
app.get('/logout', (req, res) => { /* ... */ });
app.get('/api/auth-status', (req, res) => { /* ... */ });
// Auth routes poora code
app.post('/login', (req, res) => { if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) { req.session.loggedIn = true; res.json({ success: true }); } else { res.status(401).json({ success: false, message: 'Invalid Credentials' }); }});
app.get('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/auth-status', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));


// Device & Settings Routes
app.get('/api/devices', checkAuth, async (req, res) => { /* ... */ });
app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => { /* ... */ });
app.post('/api/toggle-gemini/:clientId', checkAuth, async (req, res) => { /* ... */ });
app.post('/api/toggle-autoread/:clientId', checkAuth, async (req, res) => { /* ... */ });
// Device routes poora code
app.get('/api/devices', checkAuth, async (req, res) => {
    const config = await readDeviceConfig();
    const deviceList = Object.keys(config).map(clientId => ({
        id: clientId,
        status: clientStatuses[clientId] || 'Disconnected',
        geminiEnabled: config[clientId].geminiEnabled || false,
        autoReadEnabled: config[clientId].autoReadEnabled || false
    }));
    res.json(deviceList);
});
app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => { const client = clients[req.params.clientId]; if (client) { await client.logout(); res.json({ success: true }); } else { res.status(404).json({ success: false }); }});
app.post('/api/toggle-gemini/:clientId', checkAuth, async (req, res) => { const config = await readDeviceConfig(); if (config[req.params.clientId]) { config[req.params.clientId].geminiEnabled = !config[req.params.clientId].geminiEnabled; await writeDeviceConfig(config); res.json({ success: true }); } else { res.status(404).send(); }});
app.post('/api/toggle-autoread/:clientId', checkAuth, async (req, res) => { const config = await readDeviceConfig(); if (config[req.params.clientId]) { config[req.params.clientId].autoReadEnabled = !config[req.params.clientId].autoReadEnabled; await writeDeviceConfig(config); res.json({ success: true }); } else { res.status(404).send(); }});


// NAYA: Global Settings API
app.get('/api/settings', checkAuth, async (req, res) => {
    const config = await readGlobalConfig();
    // Security: API key ko poora nahi bhejenge, sirf aakhri 4 characters
    if (config.geminiApiKey && config.geminiApiKey.length > 4) {
        config.geminiApiKey = `...${config.geminiApiKey.slice(-4)}`;
    }
    res.json(config);
});
app.post('/api/settings', checkAuth, async (req, res) => {
    const { geminiApiKey, geminiModelName } = req.body;
    const config = await readGlobalConfig();
    // Agar user ne naya key nahi daala, to purana wala hi rakhein
    if (geminiApiKey && !geminiApiKey.includes('...')) {
        config.geminiApiKey = geminiApiKey;
    }
    config.geminiModelName = geminiModelName;
    await writeGlobalConfig(config);
    res.json({ success: true });
});

// Keyword API Routes
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => { /* ... */ });
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => { /* ... */ });
app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => { /* ... */ });
// Keyword routes poora code
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => { const config = await readDeviceConfig(); res.json(config[req.params.clientId]?.keywords || []); });
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => { const { clientId } = req.params; const config = await readDeviceConfig(); if (!config[clientId]) return res.status(404).send(); const newKeyword = { id: Date.now(), ...req.body }; config[clientId].keywords.push(newKeyword); await writeDeviceConfig(config); res.status(201).json(newKeyword); });
app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => { const { clientId, keywordId } = req.params; const config = await readDeviceConfig(); if (!config[clientId]) return res.status(404).send(); config[clientId].keywords = config[clientId].keywords.filter(k => k.id != keywordId); await writeDeviceConfig(config); res.status(204).send(); });


// --- WhatsApp Client Logic (Updated) ---
const initializeClient = async (clientId) => { /* ... (Pehle jaisa hi, koi badlaav nahi) ... */ };
const initializeClient_full = async (clientId) => {
    if (clients[clientId]) return;

    clientStatuses[clientId] = 'Initializing';
    io.emit('statusUpdate', { clientId, status: 'Initializing' });

    const config = await readDeviceConfig();
    if (!config[clientId]) {
        config[clientId] = { geminiEnabled: false, autoReadEnabled: false, keywords: [] };
        await writeDeviceConfig(config);
    }

    const client = new Client({ authStrategy: new LocalAuth({ clientId }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } });

    client.on('qr', qr => { /* ... */ });
    client.on('ready', () => { /* ... */ });
    client.on('disconnected', () => { /* ... */ });
    // Event handlers
    client.on('qr', qr => { clientStatuses[clientId] = 'Needs QR Scan'; io.emit('statusUpdate', { clientId, status: 'Needs QR Scan' }); qrcode.toDataURL(qr, (err, url) => { if (!err) io.emit('qr', { clientId, url }); }); });
    client.on('ready', () => { clientStatuses[clientId] = 'Connected'; io.emit('statusUpdate', { clientId, status: 'Connected' }); });
    client.on('disconnected', () => { clientStatuses[clientId] = 'Disconnected'; io.emit('statusUpdate', { clientId, status: 'Disconnected' }); delete clients[clientId]; });


    client.on('message', async message => {
        const deviceConfig = (await readDeviceConfig())[clientId];
        if (!deviceConfig) return;

        // AutoRead, Keywords logic pehle jaisa hi
        // ...
        
        // Gemini Logic (Updated to be dynamic)
        if (deviceConfig.geminiEnabled) {
            const globalConfig = await readGlobalConfig();
            if (!globalConfig.geminiApiKey) {
                console.log(`[${clientId}] Gemini is enabled but API key is not set.`);
                return;
            }
            try {
                const genAI = new GoogleGenerativeAI(globalConfig.geminiApiKey);
                const model = genAI.getGenerativeModel({ model: globalConfig.geminiModelName });
                const result = await model.generateContent(message.body);
                const response = await result.response;
                message.reply(response.text());
            } catch (error) {
                console.error(`[${clientId}] Gemini API Error:`, error.message);
            }
        }
    });

    client.initialize().catch(err => { /* ... */ });
    clients[clientId] = client;
};


// --- Socket.IO & Server Startup ---
io.on('connection', socket => { /* ... */ });
const reinitializeExistingSessions = async () => { /* ... */ };
server.listen(port, () => { /* ... */ });
// Poora code
io.on('connection', socket => { socket.on('add-device', ({ clientId }) => { const cleanClientId = clientId.replace(/\s+/g, '_'); if (cleanClientId) initializeClient(cleanClientId); }); });
const reinitializeExistingSessions_full = async () => { const config = await readDeviceConfig(); Object.keys(config).forEach(clientId => initializeClient(clientId)); };
server.listen(port, () => { console.log(`Server is running on http://localhost:${port}`); reinitializeExistingSessions_full(); });
