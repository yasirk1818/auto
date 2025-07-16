// --- Imports ---
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const port = 3000;
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
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
const checkAuth = (req, res, next) => req.session.loggedIn ? next() : res.status(401).json({ error: 'Unauthorized' });

// --- Auth Routes ---
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

// --- Device & Keyword API ---
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
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});
app.get('/api/keywords/:clientId', checkAuth, (req, res) => { /* ... Code from previous answer ... */ });
app.post('/api/keywords/:clientId', checkAuth, (req, res) => { /* ... Code from previous answer ... */ });
// Yahan keywords wala code daal dein
app.get('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const filePath = getKeywordsPath(req.params.clientId);
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (e) { res.json([]); }
});
app.post('/api/keywords/:clientId', checkAuth, async (req, res) => {
    const filePath = getKeywordsPath(req.params.clientId);
    try {
        const data = await fs.promises.readFile(filePath, 'utf8');
        const keywords = JSON.parse(data);
        keywords.push({ id: Date.now(), ...req.body });
        await fs.promises.writeFile(filePath, JSON.stringify(keywords, null, 2));
        res.status(201).json(keywords);
    } catch (e) { res.status(500).send(); }
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
        qrcode.toDataURL(qr, (err, url) => io.emit('qr', { clientId, url }));
    });
    client.on('ready', () => {
        clientStatuses[clientId] = 'Connected';
        io.emit('statusUpdate', { clientId, status: 'Connected' });
    });
    client.on('disconnected', () => {
        clientStatuses[clientId] = 'Disconnected';
        io.emit('statusUpdate', { clientId, status: 'Disconnected' });
        delete clients[clientId];
    });
    client.on('message', async message => { /* ... Message logic here ... */ });

    client.initialize().catch(err => {
        clientStatuses[clientId] = 'Failed';
        io.emit('statusUpdate', { clientId, status: 'Failed' });
    });
    clients[clientId] = client;
};

// --- Socket.IO Logic ---
io.on('connection', socket => {
    socket.on('add-device', ({ clientId }) => {
        if (clientId && !clients[clientId]) initializeClient(clientId);
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

// YEH SABSE ZAROORI HISSA HAI - SERVER SIRF EK BAAR LISTEN KAR RAHA HAI
server.listen(port, () => {
    console.log(`Server is clean and running on http://localhost:${port}`);
    reinitializeExistingSessions();
});
