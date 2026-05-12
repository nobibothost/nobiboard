// FILE: backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); 
app.use(express.static(path.join(__dirname, 'public'))); 

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

const wordSchema = new mongoose.Schema({
    word: { type: String, required: true, trim: true, unique: true },
    timestamp: { type: Date, default: Date.now }
});
const Word = mongoose.model('Word', wordSchema);

const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
        return res.status(403).json({ error: "Access Denied: Invalid or Missing API Key" });
    }
    next();
};

// 1. Save single word (from Keyboard typing)
app.post('/api/save_word', verifyApiKey, async (req, res) => {
    try {
        const { word } = req.body;
        if (!word) {
            return res.status(400).json({ error: "Word is required" });
        }

        const existingWord = await Word.findOne({ word: word.toLowerCase() });
        if (existingWord) {
            return res.status(200).json({ message: "Word already exists in DB, skipping." });
        }

        const newWord = new Word({ word: word.toLowerCase() });
        await newWord.save();

        res.status(200).json({ message: "Word saved successfully" });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 2. Bulk Import Words with Groq AI Smart Filtering
app.post('/api/import_words', verifyApiKey, async (req, res) => {
    try {
        const { wordsText, groqKey } = req.body;
        if (!wordsText) return res.status(400).json({ error: "No words provided" });

        // Basic Regex Cleaning: Split by whitespace, ignore URLs/Emails/Numbers
        const rawTokens = wordsText.split(/\s+/);
        const validWords = [];

        for (let token of rawTokens) {
            if (token.includes('@') || token.match(/.*(http|www|\.[a-z]{2,}).*/)) {
                continue;
            }
            let cleaned = token.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase();
            if (cleaned.length > 1 && /^[a-z]+$/.test(cleaned)) {
                validWords.push(cleaned);
            }
        }
        
        let uniqueWords = [...new Set(validWords)];

        // --- GROQ AI INTEGRATION FOR SMART FILTERING ---
        if (groqKey && uniqueWords.length > 0) {
            try {
                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${groqKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: "llama3-8b-8192",
                        messages: [
                            { 
                                role: "system", 
                                content: "You are a strict dictionary filter. You will receive a space-separated list of words. Your ONLY job is to identify and keep valid, real English, Hindi, or Hinglish words. You MUST discard gibberish (e.g. 'asdfg'), randomly typed nonsense, extremely long invalid characters, or severe typos. OUTPUT FORMAT: Return ONLY the cleaned, space-separated words in lowercase. Do NOT output any commas, bullet points, introductory text, or explanations." 
                            },
                            { role: "user", content: uniqueWords.join(" ") }
                        ],
                        temperature: 0.1
                    })
                });

                if (!response.ok) {
                    throw new Error(`Groq API Error: ${response.statusText}`);
                }

                const aiData = await response.json();
                if (aiData.choices && aiData.choices[0] && aiData.choices[0].message) {
                    const aiOutput = aiData.choices[0].message.content;
                    const aiTokens = aiOutput.split(/\s+/);
                    const aiCleaned = aiTokens.filter(w => w.length > 1 && /^[a-z]+$/.test(w));
                    uniqueWords = [...new Set(aiCleaned)]; // Override with AI cleaned list
                }
            } catch (error) {
                console.error("Groq AI Error:", error);
                return res.status(500).json({ error: "Groq AI Filtering failed. Please check your Groq API Key." });
            }
        }
        // ------------------------------------------------

        let addedCount = 0;
        for (let w of uniqueWords) {
            const exists = await Word.findOne({ word: w });
            if (!exists) {
                await new Word({ word: w }).save();
                addedCount++;
            }
        }

        res.status(200).json({ message: `Success! Added ${addedCount} highly valid words to the global dictionary.` });
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error during import" });
    }
});

// 3. Get all words for Android Sync
app.get('/api/get_all_words', verifyApiKey, async (req, res) => {
    try {
        const allWords = await Word.find({}, 'word -_id');
        const wordList = allWords.map(obj => obj.word);
        res.status(200).json({ words: wordList });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch dictionary" });
    }
});

// 4. Status for Dashboard
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

app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
