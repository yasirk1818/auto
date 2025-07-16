// --- Imports ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs').promises; // Using promise-based fs for async/await
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const port = 3000;

// --- In-memory storage ---
const clients = {};
const clientStatuses = {};
const DEVICES_CONFIG_PATH = path.join(__dirname, 'devices.json');
const GLOBAL_CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Helper Functions to read/write configs ---
const readConfig = async (filePath, defaultConfig = {}) => {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return defaultConfig;
        throw error;
    }
};
const writeConfig = async (filePath, config) => {
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
};

// --- Credentials & Middlewares ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'this-is-the-final-secret-key-i-promise-again',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });

// --- Authentication Routes ---
app.post('/login', (req, res) => {
    if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid Credentials' });
    }
});
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});
app.get('/api/auth-status', (req, res) => {
    res.json({ loggedIn: !!req.session.loggedIn });
});

// --- Device & Settings API Routes ---
app.get('/api/devices', checkAuth, async (req, res) => {
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    const deviceList = Object.keys(config).map(clientId => ({
        id: clientId,
        status: clientStatuses[clientId] || 'Disconnected',
        geminiEnabled: config[clientId].geminiEnabled || false,
        autoReadEnabled: config[clientId].autoReadEnabled || false
    }));
    res.json(deviceList);
});

app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => {
    const client = clients[req.params.clientId];
    if (client) {
        await client.logout();
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

app.post('/api/toggle-gemini/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    if (config[clientId]) {
        config[clientId].geminiEnabled = !config[clientId].geminiEnabled;
        await writeConfig(DEVICES_CONFIG_PATH, config);
        res.json({ success: true });
    } else { res.status(404).send(); }
});

app.post('/api/toggle-autoread/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    if (config[clientId]) {
        config[clientId].autoReadEnabled = !config[clientId].autoReadEnabled;
        await writeConfig(DEVICES_CONFIG_PATH, config);
        res.json({ success: true });
    } else { res.status(404).send(); }
});

// Global Settings API
app.get('/api/settings', checkAuth, async (req, res) => {
    const config = await readConfig(GLOBAL_CONFIG_PATH, { geminiApiKey: "", geminiModelName: "gemini-1.0-pro" });
    if (config.geminiApiKey && config.geminiApiKey.length > 4) {
        config.geminiApiKey = `...${config.geminiApiKey.slice(-4)}`;
    }
    res.json(config);
});
app.post('/api/settings', checkAuth, async (req, res) => {
    const { geminiApiKey, geminiModelName } = req.body;
    const config = await readConfig(GLOBAL_CONFIG_PATH, {});
    if (geminiApiKey && !geminiApiKey.includes('...')) {
        config.geminiApiKey = geminiApiKey;
    }
    config.geminiModelName = geminiModelName || "gemini-1.0-pro";
    await writeConfig(GLOBAL_CONFIG_PATH, config);
    res.json({ success: true, message: "Settings saved successfully!" });
});

// Keyword API Routes
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    res.json(config[req.params.clientId]?.keywords || []);
});

app.post('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    if (!config[clientId]) return res.status(404).send();
    const newKeyword = { id: Date.now(), ...req.body };
    config[clientId].keywords.push(newKeyword);
    await writeConfig(DEVICES_CONFIG_PATH, config);
    res.status(201).json(newKeyword);
});

app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => {
    const { clientId, keywordId } = req.params;
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    if (!config[clientId]) return res.status(404).send();
    config[clientId].keywords = config[clientId].keywords.filter(k => k.id != keywordId);
    await writeConfig(DEVICES_CONFIG_PATH, config);
    res.status(204).send();
});

// --- WhatsApp Client Logic ---
const initializeClient = async (clientId) => {
    if (clients[clientId]) return;
    clientStatuses[clientId] = 'Initializing';
    io.emit('statusUpdate', { clientId, status: 'Initializing' });
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    if (!config[clientId]) {
        config[clientId] = { geminiEnabled: false, autoReadEnabled: false, keywords: [] };
        await writeConfig(DEVICES_CONFIG_PATH, config);
    }
    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] }
    });
    client.on('qr', qr => { clientStatuses[clientId] = 'Needs QR Scan'; io.emit('statusUpdate', { clientId, status: 'Needs QR Scan' }); qrcode.toDataURL(qr, (err, url) => { if (!err) io.emit('qr', { clientId, url }); }); });
    client.on('ready', () => { clientStatuses[clientId] = 'Connected'; io.emit('statusUpdate', { clientId, status: 'Connected' }); });
    client.on('disconnected', () => { clientStatuses[clientId] = 'Disconnected'; io.emit('statusUpdate', { clientId, status: 'Disconnected' }); delete clients[clientId]; });
    client.on('message', async message => {
        const deviceConfig = (await readConfig(DEVICES_CONFIG_PATH, {}))[clientId];
        if (!deviceConfig) return;
        if (deviceConfig.autoReadEnabled) { try { await message.getChat().then(chat => chat.sendSeen()); } catch (e) { console.log("Could not mark as read"); } }
        const incomingMessage = message.body.toLowerCase();
        for (const item of deviceConfig.keywords) {
            if ((item.match_type === 'exact' && incomingMessage === item.keyword.toLowerCase()) || (item.match_type === 'contains' && incomingMessage.includes(item.keyword.toLowerCase()))) {
                return message.reply(item.reply);
            }
        }
        if (deviceConfig.geminiEnabled) {
            let genAI, model;
            try {
                const globalConfig = await readConfig(GLOBAL_CONFIG_PATH, {});
                if (!globalConfig.geminiApiKey) {
                    return console.log(`[${clientId}] Gemini enabled but no API key set.`);
                }
                genAI = new GoogleGenerativeAI(globalConfig.geminiApiKey);
                model = genAI.getGenerativeModel({ model: globalConfig.geminiModelName });
                const result = await model.generateContent(message.body);
                message.reply(result.response.text());
            } catch (error) {
                console.error(`[${clientId}] Gemini Error:`, error.message);
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
    const config = await readConfig(DEVICES_CONFIG_PATH, {});
    console.log(`Found ${Object.keys(config).length} device(s). Re-initializing...`);
    Object.keys(config).forEach(clientId => initializeClient(clientId));
};

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
