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

// --- In-memory storage ---
const clients = {};
const clientStatuses = {}; // NAYA: Har client ka status store karega

// --- Helper Functions ---
const getKeywordsPath = (clientId) => path.join(__dirname, `keywords_${clientId}.json`);
const getSessionPath = () => path.join(__dirname, '.wwebjs_auth');

// --- Credentials & Session ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'a-very-super-secret-key-for-multi-device',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });

// --- Auth Routes ---
app.post('/login', (req, res) => { /* ... (Pehle jaisa hi) ... */ });
app.get('/logout', (req, res) => { /* ... (Pehle jaisa hi) ... */ });
app.get('/api/auth-status', (req, res) => { /* ... (Pehle jaisa hi) ... */ });
// Auth routes from previous code
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid Credentials' });
    }
});
app.get('/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/auth-status', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));


// --- Device Management API (Updated) ---
app.get('/api/devices', checkAuth, (req, res) => {
    const sessionDir = getSessionPath();
    if (!fs.existsSync(sessionDir)) {
        return res.json([]);
    }
    const deviceDirs = fs.readdirSync(sessionDir)
        .filter(file => file.startsWith('session-'))
        .map(file => {
            const clientId = file.substring(8);
            return {
                id: clientId,
                status: clientStatuses[clientId] || 'Disconnected' // Status bhi bhejein
            };
        });
    res.json(deviceDirs);
});

// NAYA: API to disconnect a device
app.post('/api/disconnect/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const client = clients[clientId];
    if (client) {
        await client.logout(); // whatsapp-web.js ka logout function
        res.json({ success: true, message: `Disconnecting ${clientId}.` });
    } else {
        res.status(404).json({ success: false, message: 'Device not found or not running.' });
    }
});

// --- Keyword Management API (Pehle jaisa hi) ---
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => { /* ... */ });
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => { /* ... */ });
// Full keyword API code
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const filePath = getKeywordsPath(clientId);
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.promises.writeFile(filePath, '[]', 'utf8');
            return res.json([]);
        }
        res.status(500).send(`Error reading keywords for ${clientId}`);
    }
});
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const { clientId } = req.params;
    const filePath = getKeywordsPath(clientId);
    try {
        let keywords = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        const newKeyword = { id: Date.now(), ...req.body };
        keywords.push(newKeyword);
        await fs.promises.writeFile(filePath, JSON.stringify(keywords, null, 2));
        res.status(201).json(newKeyword);
    } catch (error) {
        res.status(500).send(`Error saving keyword for ${clientId}`);
    }
});


// --- Function to Create and Initialize a WhatsApp Client (Updated) ---
function initializeClient(clientId) {
    if (clients[clientId]) return;
    console.log(`Initializing client for: ${clientId}`);
    clientStatuses[clientId] = 'Initializing'; // NAYA: Set initial status
    io.emit('statusUpdate', { clientId, status: clientStatuses[clientId] });

    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => {
        console.log(`QR received for ${clientId}`);
        clientStatuses[clientId] = 'Needs QR Scan'; // NAYA: Update status
        io.emit('statusUpdate', { clientId, status: clientStatuses[clientId] });
        qrcode.toDataURL(qr, (err, url) => {
            if (!err) io.emit('qr', { clientId, url });
        });
    });

    client.on('ready', () => {
        console.log(`Client is ready for ${clientId}!`);
        clientStatuses[clientId] = 'Connected'; // NAYA: Update status
        io.emit('statusUpdate', { clientId, status: clientStatuses[clientId] });
        io.emit('ready', { clientId });
    });

    client.on('disconnected', (reason) => {
        console.log(`Client for ${clientId} was logged out`, reason);
        clientStatuses[clientId] = 'Disconnected'; // NAYA: Update status
        io.emit('statusUpdate', { clientId, status: clientStatuses[clientId] });
        delete clients[clientId]; // Memory se client instance ko remove karein
    });

    client.on('message', async (message) => { /* ... (Pehle jaisa hi) ... */ });
    // Full message handler
    client.on('message', async (message) => {
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
        console.error(`Failed to initialize client ${clientId}:`, err)
        clientStatuses[clientId] = 'Failed';
        io.emit('statusUpdate', { clientId, status: clientStatuses[clientId] });
    });
    clients[clientId] = client;
}

// --- Socket.IO Connection and Server Startup (Pehle jaisa hi) ---
io.on('connection', (socket) => { /* ... */ });
function reinitializeExistingSessions() { /* ... */ }
server.listen(port, () => { /* ... */ });
// Full code for these sections
io.on('connection', (socket) => {
    socket.on('add-device', (data) => {
        const { clientId } = data;
        if (clientId && !clients[clientId]) {
            initializeClient(clientId);
            socket.emit('message', `Starting new device: ${clientId}. Please wait for QR code.`);
        } else {
            socket.emit('message', `Device ID ${clientId} is invalid or already running.`);
        }
    });
});
function reinitializeExistingSessions() {
    console.log('Re-initializing existing sessions...');
    const sessionDir = getSessionPath();
    if (!fs.existsSync(sessionDir)) return;
    const deviceDirs = fs.readdirSync(sessionDir)
        .filter(file => file.startsWith('session-'))
        .map(file => file.substring(8));
    deviceDirs.forEach(clientId => initializeClient(clientId));
}
server.listen(port, () => {
    console.log(`Server with Multi-Device support running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
