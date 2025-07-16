// --- Imports ---
require('dotenv').config(); // Loads .env file contents into process.env
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

// --- Gemini AI Setup ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// --- Helper Functions to read/write device config ---
const readDeviceConfig = async () => {
    try {
        const data = await fs.readFile(DEVICES_CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // If file doesn't exist, return empty object
            return {};
        }
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
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'auto-read-and-gemini-is-the-best-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
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
    const config = await readDeviceConfig();
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
    const config = await readDeviceConfig();
    if (config[clientId]) {
        config[clientId].geminiEnabled = !config[clientId].geminiEnabled;
        await writeDeviceConfig(config);
        res.json({ success: true, geminiEnabled: config[clientId].geminiEnabled });
    } else {
        res.status(404).send('Device not found');
    }
});

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

// --- Keyword API Routes ---
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
    const initialLength = config[clientId].keywords.length;
    config[clientId].keywords = config[clientId].keywords.filter(k => k.id != keywordId);
    if (config[clientId].keywords.length === initialLength) {
         return res.status(404).send('Keyword not found');
    }
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
        config[clientId] = { geminiEnabled: false, autoReadEnabled: false, keywords: [] };
        await writeDeviceConfig(config);
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

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

    client.on('message', async message => {
        const currentConfig = await readDeviceConfig();
        const deviceConfig = currentConfig[clientId];
        if (!deviceConfig) return;

        if (deviceConfig.autoReadEnabled) {
            try {
                const chat = await message.getChat();
                await chat.sendSeen();
            } catch (e) { console.error(`[${clientId}] Failed to mark as read:`, e); }
        }
        
        const incomingMessage = message.body.toLowerCase();
        for (const item of deviceConfig.keywords) {
            if ((item.match_type === 'exact' && incomingMessage === item.keyword.toLowerCase()) ||
                (item.match_type === 'contains' && incomingMessage.includes(item.keyword.toLowerCase()))) {
                return message.reply(item.reply);
            }
        }

        if (deviceConfig.geminiEnabled) {
            try {
                const result = await geminiModel.generateContent(message.body);
                const response = await result.response;
                message.reply(response.text());
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

// --- Socket.IO Connection Logic ---
io.on('connection', socket => {
    socket.on('add-device', ({ clientId }) => {
        const cleanClientId = clientId.replace(/\s+/g, '_');
        if (cleanClientId) initializeClient(cleanClientId);
    });
});

// --- Server Startup Logic ---
const reinitializeExistingSessions = async () => {
    const config = await readDeviceConfig();
    console.log(`Found ${Object.keys(config).length} device(s) in config. Re-initializing...`);
    Object.keys(config).forEach(clientId => initializeClient(clientId));
};

server.listen(port, () => {
    console.log(`Server with AutoRead & Gemini support is running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
