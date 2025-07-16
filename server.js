const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = 3000;

const KEYWORDS_FILE_PATH = './keywords.json';

// --- Express Server Setup ---
app.use(bodyParser.json());
app.use(express.static('public'));

// API to get all keywords
app.get('/api/keywords', async (req, res) => {
    try {
        const data = await fs.readFile(KEYWORDS_FILE_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).send('Error reading keywords file');
    }
});

// API to add a new keyword
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

// API to update a keyword
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

// API to delete a keyword
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

// --- WhatsApp Bot Setup ---
const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
});

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

client.initialize();

app.listen(port, () => {
    console.log(`Web panel listening at http://localhost:${port}`);
});
