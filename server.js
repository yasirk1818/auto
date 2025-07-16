const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const session = require('express-session');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const port = 3000;
const KEYWORDS_FILE_PATH = './keywords.json';

// --- Credentials (Inhe aap badal sakte hain) ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "password123";

// --- Middlewares ---
app.use(express.static('public')); // 'public' folder ko serve karein
app.use(express.json()); // JSON requests ko parse karein
app.use(express.urlencoded({ extended: true })); // Form data ko parse karein

// Session Middleware
app.use(session({
    secret: 'a-very-long-and-random-secret-key-for-session', // Isko ek random string se zaroor badlein
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Session 24 ghante tak valid rahega
}));

// Middleware to check if user is logged in
const checkAuth = (req, res, next) => {
    if (req.session.loggedIn) {
        next(); // Logged in hai, to aage badhne do
    } else {
        res.status(401).json({ error: 'Unauthorized' }); // Logged in nahi hai, to error do
    }
};

// --- Authentication Routes ---
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.loggedIn = true; // Session mein login status set karo
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid Credentials' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// Route to check current authentication status
app.get('/api/auth-status', (req, res) => {
    res.json({ loggedIn: !!req.session.loggedIn });
});

// --- Protected API Routes for Keywords ---
app.get('/api/keywords', checkAuth, async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(KEYWORDS_FILE_PATH, '[]', 'utf8');
            return res.json([]);
        }
        res.status(500).send('Error reading keywords file');
    }
});

app.post('/api/keywords', checkAuth, async (req, res) => {
    try {
        let keywords = JSON.parse(await fs.readFile(KEYWORDS_FILE_PATH, 'utf8'));
        const newKeyword = { id: Date.now(), ...req.body };
        keywords.push(newKeyword);
        await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
        res.status(201).json(newKeyword);
    } catch (error) {
        res.status(500).send('Error saving keyword');
    }
});

app.delete('/api/keywords/:id', checkAuth, async (req, res) => {
    try {
        let keywords = JSON.parse(await fs.readFile(KEYWORDS_FILE_PATH, 'utf8'));
        keywords = keywords.filter(k => k.id != req.params.id);
        await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
        res.status(204).send();
    } catch (error) {
        res.status(500).send('Error deleting keyword');
    }
});

// --- WhatsApp Client and Socket.IO Logic ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

io.on('connection', (socket) => {
    console.log('A user connected to the web panel.');

    client.on('qr', (qr) => qrcode.toDataURL(qr, (err, url) => {
        if (!err) socket.emit('qr', url);
    }));
    client.on('ready', () => socket.emit('ready'));
    client.on('disconnected', () => socket.emit('disconnected'));
});

client.on('message', async (message) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
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
        if (error.code !== 'ENOENT') console.error('Error processing message:', error);
    }
});

// --- Start Server and Client ---
client.initialize().catch(console.error);
server.listen(port, () => console.log(`Server running on http://localhost:${port}`));
