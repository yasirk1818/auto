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

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const port = 3000;
const clients = {};
const clientStatuses = {};
const DEVICES_CONFIG_PATH = path.join(__dirname, 'devices.json');
const GLOBAL_CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Helper Functions ---
const readConfig = async (filePath, defaultConfig = {}) => {
    try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) { return defaultConfig; }
};
const writeConfig = async (filePath, config) => {
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
};

// --- Middlewares & Credentials ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'this-is-the-final-secret-for-the-panel-v4',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });

// --- API Routes ---
// Auth
app.post('/login', (req, res) => { if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) { req.session.loggedIn = true; res.json({ success: true }); } else { res.status(401).json({ success: false }); } });
app.get('/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });
app.get('/api/auth-status', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));

// Devices
app.get('/api/devices', checkAuth, async (req, res) => {
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    res.json(Object.keys(config).map(id => ({
        id,
        status: clientStatuses[id] || 'Disconnected',
        typingEnabled: config[id].typingEnabled || false,
        autoReadEnabled: config[id].autoReadEnabled || false,
        geminiEnabled: config[id].geminiEnabled || false
    })));
});
app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => { if (clients[req.params.clientId]) { await clients[req.params.clientId].logout(); res.json({ success: true }); } else { res.status(404).send(); } });

// === YEH SABSE ZAROORI BADLAAV HAI ===
// Generic toggle handler that correctly saves the state
app.post('/api/toggle-setting/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const { setting } = req.body;

    console.log(`Received toggle request for [${clientId}] -> Setting: [${setting}]`); // LOGGING

    if (!setting) return res.status(400).json({ success: false, message: 'Setting name is required.' });

    try {
        const config = await readConfig(DEVICES_CONFIG_PATH, {});
        if (config[clientId] && typeof config[clientId][setting] !== 'undefined') {
            // Toggle the boolean value
            config[clientId][setting] = !config[clientId][setting];
            // Write the updated config back to the file
            await writeConfig(DEVICES_CONFIG_PATH, config);
            console.log(`SUCCESS: [${clientId}] -> Setting '${setting}' updated to ${config[clientId][setting]}`); // SUCCESS LOG
            res.json({ success: true });
        } else {
            console.log(`FAILURE: [${clientId}] -> Device or setting not found.`); // FAILURE LOG
            res.status(404).json({ success: false, message: 'Device or setting not found' });
        }
    } catch (error) {
        console.error("CRITICAL ERROR toggling setting:", error); // CRITICAL ERROR LOG
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});


// Global Settings
app.get('/api/settings', checkAuth, async (req, res) => { const config = await readConfig(GLOBAL_CONFIG_PATH, { geminiApiKey: "", geminiModelName: "gemini-1.0-pro" }); if (config.geminiApiKey) config.geminiApiKey = `...${config.geminiApiKey.slice(-4)}`; res.json(config); });
app.post('/api/settings', checkAuth, async (req, res) => { const { geminiApiKey, geminiModelName } = req.body; const config = await readConfig(GLOBAL_CONFIG_PATH, {}); if (geminiApiKey && !geminiApiKey.includes('...')) config.geminiApiKey = geminiApiKey; config.geminiModelName = geminiModelName || "gemini-1.0-pro"; await writeConfig(GLOBAL_CONFIG_PATH, config); res.json({ success: true }); });

// Keywords
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => { const config = await readConfig(DEVICES_CONFIG_PATH, {}); res.json(config[req.params.clientId]?.keywords || []); });
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => { const { clientId } = req.params; const config = await readConfig(DEVICES_CONFIG_PATH, {}); if (!config[clientId]) return res.status(404).send(); config[clientId].keywords.push({ id: Date.now(), ...req.body }); await writeConfig(DEVICES_CONFIG_PATH, config); res.status(201).send(); });
app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => { const { clientId, keywordId } = req.params; const config = await readConfig(DEVICES_CONFIG_PATH, {}); if (!config[clientId]) return res.status(404).send(); config[clientId].keywords = config[clientId].keywords.filter(k => k.id != keywordId); await writeConfig(DEVICES_CONFIG_PATH, config); res.status(204).send(); });

// --- WhatsApp Client Logic ---
const initializeClient = async (clientId) => {
    if (clients[clientId]) return;
    clientStatuses[clientId] = 'Initializing'; io.emit('statusUpdate', { clientId, status: 'Initializing' });
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    if (!config[clientId]) {
        config[clientId] = { geminiEnabled: false, autoReadEnabled: false, typingEnabled: false, keywords: [] };
        await writeConfig(DEVICES_CONFIG_PATH, config);
    }
    const client = new Client({ authStrategy: new LocalAuth({ clientId }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] } });
    client.on('qr', qr => { clientStatuses[clientId] = 'Needs QR Scan'; io.emit('statusUpdate', { clientId, status: 'Needs QR Scan' }); qrcode.toDataURL(qr, (err, url) => { if (!err) io.emit('qr', { clientId, url }); }); });
    client.on('ready', () => { clientStatuses[clientId] = 'Connected'; io.emit('statusUpdate', { clientId, status: 'Connected' }); });
    client.on('disconnected', () => { clientStatuses[clientId] = 'Disconnected'; io.emit('statusUpdate', { clientId, status: 'Disconnected' }); delete clients[clientId]; });
    client.on('message', async message => {
        const deviceConfig = (await readConfig(DEVICES_CONFIG_PATH, {}))[clientId];
        if (!deviceConfig) return;
        const chat = await message.getChat();
        if (deviceConfig.autoReadEnabled) { try { await chat.sendSeen(); } catch (e) { /* ignore */ } }
        const incomingMessage = message.body.toLowerCase();
        let replyContent = null;
        for (const item of deviceConfig.keywords) { if ((item.match_type === 'exact' && incomingMessage === item.keyword.toLowerCase()) || (item.match_type === 'contains' && incomingMessage.includes(item.keyword.toLowerCase()))) { replyContent = item.reply; break; } }
        if (!replyContent && deviceConfig.geminiEnabled) {
            try {
                const globalConfig = await readConfig(GLOBAL_CONFIG_PATH, {});
                if (!globalConfig.geminiApiKey) return console.log(`[${clientId}] Gemini enabled but no API key set.`);
                const genAI = new GoogleGenerativeAI(globalConfig.geminiApiKey);
                const model = genAI.getGenerativeModel({ model: globalConfig.geminiModelName });
                const result = await model.generateContent(message.body);
                replyContent = result.response.text();
            } catch (error) { replyContent = "AI Error: Could not generate response."; console.error(error); }
        }
        if (replyContent) {
            if (deviceConfig.typingEnabled) { await chat.sendStateTyping(); await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000) + 1000)); await chat.clearState(); await chat.sendMessage(replyContent); }
            else { message.reply(replyContent); }
        }
    });
    client.initialize().catch(err => { console.error(`Init failed for ${clientId}:`, err); clientStatuses[clientId] = 'Failed'; io.emit('statusUpdate', { clientId, status: 'Failed' }); });
    clients[clientId] = client;
};

// --- Socket.IO & Server Startup ---
io.on('connection', socket => { socket.on('add-device', ({ clientId }) => { const cleanClientId = clientId.replace(/\s+/g, '_'); if (cleanClientId) initializeClient(cleanClientId); }); });
const reinitializeExistingSessions = async () => { const config = await readConfig(DEVICES_CONFIG_PATH, {}); Object.keys(config).forEach(clientId => initializeClient(clientId)); };
server.listen(port, () => { console.log(`Server is running on http://localhost:${port}`); reinitializeExistingSessions(); });
