const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
// Woh extra line yahan se hata di gayi hai
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = 3000;
const KEYWORDS_FILE_PATH = './keywords.json';

// --- Express Server Setup ---
app.use(express.json());
app.use(express.static('public'));

// API routes for keywords remain the same
app.get('/api/keywords', async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).send('Error reading keywords file');
    }
});

app.post('/api/keywords', async (req, res) => {
    try {
        const keywords = JSON.parse(await fs.readFile(KEYWORDS_FILE_PATH, 'utf8'));
        const newKeyword = { id: Date.now(), ...req.body };
        keywords.push(newKeyword);
        await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
        res.status(201).json(newKeyword);
    } catch (error) {
        res.status(500).send('Error saving keyword');
    }
});

app.put('/api/keywords/:id', async (req, res) => {
    try {
        let keywords = JSON.parse(await fs.readFile(KEYWORDS_FILE_PATH, 'utf8'));
        const keywordIndex = keywords.findIndex(k => k.id == req.params.id);
        if (keywordIndex !== -1) {
            keywords[keywordIndex] = { ...keywords[keywordIndex], ...req.body };
            await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
            res.json(keywords[keywordIndex]);
        } else {
            res.status(404).send('Keyword not found');
        }
    } catch (error) {
        res.status(500).send('Error updating keyword');
    }
});

app.delete('/api/keywords/:id', async (req, res) => {
    try {
        let keywords = JSON.parse(await fs.readFile(KEYWORDS_FILE_PATH, 'utf8'));
        keywords = keywords.filter(k => k.id != req.params.id);
        await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
        res.status(204).send();
    } catch (error) {
        res.status(500).send('Error deleting keyword');
    }
});

// --- Socket.IO Connection for Real-time Updates ---
io.on('connection', (socket) => {
    console.log('Web client connected');
    socket.emit('message', 'Please wait, initializing WhatsApp client...');

    socket.on('disconnect', () => {
        console.log('Web client disconnected');
    });
});

// --- WhatsApp Bot Setup ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    // Convert QR to a Data URL to be used in an <img> tag
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR code', err);
            return;
        }
        io.emit('qr', url);
        io.emit('message', 'QR Code received, please scan.');
    });
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    io.emit('ready');
    io.emit('message', 'WhatsApp is connected and ready!');
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
    io.emit('message', 'Authentication successful!');
});

client.on('auth_failure', (msg) => {
    console.error('AUTHENTICATION FAILURE', msg);
    io.emit('message', 'Authentication failed. Please restart the server.');
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    io.emit('disconnected');
    io.emit('message', 'WhatsApp client was disconnected.');
});

// Message handling logic remains the same
client.on('message', async (message) => {
    try {
        const keywords = JSON.parse(await fs.readFile(KEYWORDS_FILE_PATH, 'utf8'));
        const incomingMessage = message.body.toLowerCase();
        for (const item of keywords) {
            const keyword = item.keyword.toLowerCase();
            const matchType = item.match_type || 'exact';
            if ((matchType === 'exact' && incomingMessage === keyword) ||
                (matchType === 'contains' && incomingMessage.includes(keyword))) {
                message.reply(item.reply);
                return;
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
});

// Initialize the client
client.initialize().catch(err => console.log(err));

// Use server.listen instead of app.listen
server.listen(port, () => {
    console.log(`Web panel listening at http://localhost:${port}`);
});
