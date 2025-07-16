// --- Imports ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const port = 3000;

// --- In-memory storage for clients and their statuses ---
const clients = {};
const clientStatuses = {};

// --- Helper Functions ---
const getKeywordsPath = (clientId) => path.join(__dirname, `keywords_${clientId}.json`);
const getSessionPath = () => path.join(__dirname, '.wwebjs_auth');

// --- Credentials ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";

// --- Middlewares ---
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'a-final-super-secret-key-for-this-project',
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
app.get('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/auth-status', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));

// --- Device & Keyword API Routes ---
app.get('/api/devices', checkAuth, (req, res) => {
    const sessionDir = getSessionPath();
    if (!fs.existsSync(sessionDir)) return res.json([]);
    const deviceDirs = fs.readdirSync(sessionDir)
        .filter(file => file.startsWith('session-'))
        .map(file => {
            const clientId = file.substring(8);
            return { id: clientId, status: clientStatuses[clientId] || 'Disconnected' };
        });
    res.json(deviceDirs);
});

app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => {
    const client = clients[req.params.clientId];
    if (client) {
        await client.logout();
        res.json({ success: true, message: `Disconnecting ${req.params.clientId}.` });
    } else {
        res.status(404).json({ success: false, message: 'Device not found or not running.' });
    }
});

app.get('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const filePath = getKeywordsPath(req.params.clientId);
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') { // If file doesn't exist, return empty array
            res.json([]);
        } else {
            res.status(500).send('Error reading keywords file.');
        }
    }
});

app.post('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const filePath = getKeywordsPath(req.params.clientId);
    let keywords = [];
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        keywords = JSON.parse(data);
    } catch (error) {
        if (error.code !== 'ENOENT') return res.status(500).send('Error reading keywords file.');
        // If file doesn't exist, it's fine, we'll create it.
    }
    const newKeyword = { id: Date.now(), ...req.body };
    keywords.push(newKeyword);
    await fs.promises.writeFile(filePath, JSON.stringify(keywords, null, 2));
    res.status(201).json(newKeyword);
});

app.delete('/api/keywords/:clientId/:keywordId', checkAuth, async (req, res) => {
    const { clientId, keywordId } = req.params;
    const filePath = getKeywordsPath(clientId);
    try {
        let data = await fs.promises.readFile(filePath, 'utf8');
        let keywords = JSON.parse(data);
        const updatedKeywords = keywords.filter(k => k.id != keywordId);
        if (keywords.length === updatedKeywords.length) {
            return res.status(404).send('Keyword not found');
        }
        await fs.promises.writeFile(filePath, JSON.stringify(updatedKeywords, null, 2));
        res.status(204).send();
    } catch (error) {
        res.status(500).send(`Error deleting keyword for ${clientId}`);
    }
});

// --- WhatsApp Client Logic ---
const initializeClient = (clientId) => {
    if (clients[clientId]) return;
    clientStatuses[clientId] = 'Initializing';
    io.emit('statusUpdate', { clientId, status: 'Initializing' });

    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', qr => {
        clientStatuses[clientId] = 'Needs QR Scan';
        io.emit('statusUpdate', { clientId, status: 'Needs QR Scan' });
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) io.emit('qr', { clientId, url });
        });
    });

    client.on('ready', () => {
        clientStatuses[clientId] = 'Connected';
        io.emit('statusUpdate', { clientId, status: 'Connected' });
    });

    client.on('disconnected', (reason) => {
        clientStatuses[clientId] = 'Disconnected';
        io.emit('statusUpdate', { clientId, status: 'Disconnected' });
        delete clients[clientId]; // Remove from active clients
    });

    client.on('message', async message => {
        const keywordsPath = getKeywordsPath(clientId);
        try {
            const data = await fs.promises.readFile(keywordsPath, 'utf8');
            const keywords = JSON.parse(data);
            const incomingMessage = message.body.toLowerCase();
            for (const item of keywords) {
                const keyword = item.keyword.toLowerCase();
                const matchType = item.match_type || 'exact';
                if ((matchType === 'exact' && incomingMessage === keyword) || (matchType === 'contains' && incomingMessage.includes(keyword))) {
                    message.reply(item.reply);
                    return;
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') console.error(`Error processing message for ${clientId}:`, error);
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
        const cleanClientId = clientId.replace(/\s+/g, '_'); // Replace spaces
        if (cleanClientId && !clients[cleanClientId]) {
            initializeClient(cleanClientId);
        }
    });
});

// --- Server Startup ---
const reinitializeExistingSessions = () => {
    const sessionDir = getSessionPath();
    if (!fs.existsSync(sessionDir)) return;
    fs.readdirSync(sessionDir)
        .filter(file => file.startsWith('session-'))
        .forEach(file => initializeClient(file.substring(8)));
};

server.listen(port, () => {
    console.log(`Server with Multi-Device support is running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
