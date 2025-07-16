
**File 2: `server.js` (Final Backend Code)**
```javascript
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
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

// Serve the public folder
app.use(express.static('public'));
app.use(express.json());

// API routes for keywords
app.get('/api/keywords', async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        // If file doesn't exist, create it with an empty array
        if (error.code === 'ENOENT') {
            await fs.writeFile(KEYWORDS_FILE_PATH, '[]', 'utf8');
            return res.json([]);
        }
        res.status(500).send('Error reading keywords file');
    }
});

app.post('/api/keywords', async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        const keywords = JSON.parse(data);
        const newKeyword = { id: Date.now(), ...req.body };
        keywords.push(newKeyword);
        await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
        res.status(201).json(newKeyword);
    } catch (error) {
        res.status(500).send('Error saving keyword');
    }
});

// --- WhatsApp Bot and Socket.IO Logic ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Important for Linux servers
    }
});

io.on('connection', (socket) => {
    console.log('A user connected to the web panel.');

    // Send initial status
    socket.emit('message', 'Initializing...');

    client.on('qr', (qr) => {
        console.log('QR Code generated. Sending to web client.');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('Failed to generate QR Data URL', err);
            } else {
                socket.emit('qr', url); // Send QR code to the connected user
                socket.emit('message', 'Please scan the QR Code with WhatsApp.');
            }
        });
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        socket.emit('ready'); // Notify client that it's ready
        socket.emit('message', 'WhatsApp is connected successfully!');
    });
    
    client.on('disconnected', (reason) => {
        socket.emit('disconnected');
        socket.emit('message', 'Client was disconnected. Please refresh the page.');
    });

    socket.on('disconnect', () => {
        console.log('User disconnected from the web panel.');
    });
});

// Initialize the client only once
client.initialize().catch(err => console.error("Client initialization error:", err));

// Start the server
server.listen(port, () => {
    console.log(`Server with Web Panel is running on http://localhost:${port}`);
});
