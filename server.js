const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
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

// --- Express Middlewares ---
// Serve static files from the 'public' folder
app.use(express.static('public'));
// Allow Express to parse JSON in request bodies
app.use(express.json());

// --- API to Manage Keywords ---

// GET all keywords
app.get('/api/keywords', async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        // If the keywords.json file doesn't exist, create it with an empty array
        if (error.code === 'ENOENT') {
            try {
                await fs.writeFile(KEYWORDS_FILE_PATH, '[]', 'utf8');
                return res.json([]);
            } catch (writeError) {
                console.error("Failed to create keywords file:", writeError);
                return res.status(500).send('Error initializing keywords file');
            }
        }
        console.error("Failed to read keywords file:", error);
        res.status(500).send('Error reading keywords file');
    }
});

// POST a new keyword
app.post('/api/keywords', async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        const keywords = JSON.parse(data);
        const newKeyword = { id: Date.now(), ...req.body };
        keywords.push(newKeyword);
        await fs.writeFile(KEYWORDS_FILE_PATH, JSON.stringify(keywords, null, 2));
        res.status(201).json(newKeyword);
    } catch (error) {
        console.error("Failed to save keyword:", error);
        res.status(500).send('Error saving keyword');
    }
});

// --- WhatsApp Client and Socket.IO Logic ---

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        // These arguments are crucial for running on many Linux servers/VPS
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// This runs when a user opens the website
io.on('connection', (socket) => {
    console.log('A user connected to the web panel.');

    // Send initial status to the user
    socket.emit('message', 'Initializing WhatsApp Client...');

    // Event: QR Code is generated
    client.on('qr', (qr) => {
        console.log('QR Code generated. Sending to the web client.');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('Error generating QR data URL:', err);
            } else {
                // Send the QR code image data to the frontend
                socket.emit('qr', url);
                socket.emit('message', 'Please scan the QR Code with your WhatsApp app.');
            }
        });
    });

    // Event: WhatsApp client is ready and connected
    client.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        // Notify the frontend that the connection is successful
        socket.emit('ready');
        socket.emit('message', 'WhatsApp is connected successfully!');
    });
    
    // Event: WhatsApp client is disconnected
    client.on('disconnected', (reason) => {
        console.log('Client was logged out:', reason);
        socket.emit('disconnected');
        socket.emit('message', 'Client was disconnected. Please refresh the page to try again.');
    });

    // Event: The user closes the website
    socket.on('disconnect', () => {
        console.log('User disconnected from the web panel.');
    });
});


// Event: A new message is received on WhatsApp
client.on('message', async (message) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        const keywords = JSON.parse(data);
        const incomingMessage = message.body.toLowerCase();

        for (const item of keywords) {
            const keyword = item.keyword.toLowerCase();
            const matchType = item.match_type || 'exact';

            if (
                (matchType === 'exact' && incomingMessage === keyword) ||
                (matchType === 'contains' && incomingMessage.includes(keyword))
            ) {
                message.reply(item.reply);
                // Stop after finding the first match
                return;
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') { // Don't log error if file just doesn't exist
            console.error('Error processing incoming message:', error);
        }
    }
});


// --- Start Everything ---

// Initialize the WhatsApp client. This should only be called once.
client.initialize().catch(err => console.error("FATAL: Client initialization failed!", err));

// Start the web server
server.listen(port, () => {
    console.log(`Server with Web Panel is running on http://localhost:${port}`);
    console.log("Open this address in your browser.");
});
