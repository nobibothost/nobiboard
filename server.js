// FILE: backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json()); // Parses incoming JSON payloads
app.use(express.static(path.join(__dirname, 'public'))); // Serves frontend dashboard

// MongoDB Connection
let isDbConnected = false;
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    isDbConnected = true;
    console.log('✅ MongoDB Connected Successfully');
}).catch((err) => {
    console.error('❌ MongoDB Connection Error:', err);
});

// Database Schema & Model
const wordSchema = new mongoose.Schema({
    word: { type: String, required: true, trim: true },
    timestamp: { type: Date, default: Date.now }
});
const Word = mongoose.model('Word', wordSchema);

// Security Middleware: API Key Checker
const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
        return res.status(403).json({ error: "Access Denied: Invalid or Missing API Key" });
    }
    next();
};

// ================= API ROUTES =================

// 1. Route for App to save new words (Protected by API Key)
app.post('/api/save_word', verifyApiKey, async (req, res) => {
    try {
        const { word } = req.body;
        if (!word) {
            return res.status(400).json({ error: "Word is required" });
        }

        // Save word to database
        const newWord = new Word({ word });
        await newWord.save();

        res.status(200).json({ message: "Word saved successfully" });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 2. Route for Frontend Dashboard to get service status
app.get('/api/status', async (req, res) => {
    try {
        const count = await Word.countDocuments();
        res.json({
            serviceStatus: 'Active',
            databaseConnected: isDbConnected,
            totalWordsSaved: count
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch status" });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
