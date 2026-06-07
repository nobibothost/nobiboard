require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const Groq = require('groq-sdk');

console.log('🔍 ENV DEBUG:');
console.log('  API_SECRET_KEY length:', process.env.API_SECRET_KEY?.length || 0);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Init Groq client
let groqClient = null;
if (process.env.GROQ_API_KEY) {
    try {
        groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
        console.log('🚀 Groq AI client initialized');
    } catch (err) { console.error('Groq init failed:', err.message); }
}

// Connect MongoDB
let isDbConnected = false;
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => { isDbConnected = true; console.log('✅ MongoDB Connected'); })
    .catch(err => console.error('MongoDB Error:', err));

const wordSchema = new mongoose.Schema({
    word: { type: String, required: true, trim: true, unique: true },
    source: { type: String, enum: ['user', 'ai'], default: 'user' },
    timestamp: { type: Date, default: Date.now }
});

wordSchema.index({ source: 1, timestamp: 1 });
const Word = mongoose.model('Word', wordSchema);

// Middleware for auth
const verifyApiKey = (req, res, next) => {
    const received = (req.headers['x-api-key'] || '').trim();
    const expected = (process.env.API_SECRET_KEY || '').trim();
    if (!received || !expected || received !== expected) {
        return res.status(403).json({ error: "Access Denied: Invalid or Missing API Key" });
    }
    next();
};

const getStartOfToday = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
};

// ==================== NEW AI LOGIC ====================

// Function to ask a random question to AI, process the paragraph, and save new words
async function autoAskQuestionAndExtractWords() {
    if (!groqClient) {
        console.log("❌ Groq client not initialized.");
        return { totalAdded: 0, allGeneratedWords: [] };
    }

    // List of random topics
    const prompts = [
        "Write a casual 100-word story about Indian college life using a mix of pure Hindi and English words written in English script.",
        "Describe a crowded Mumbai local train experience in street-style Hinglish. Just write the paragraph.",
        "Explain how to make proper desi chai using casual Indian slang and Hinglish. No formatting, just text.",
        "Talk about weekend plans and chilling with friends using casual modern Indian internet language.",
        "Describe a dramatic Bollywood movie scene in casual desi Hinglish.",
        "Explain the excitement of the last over of a cricket match in Indian slang."
    ];
    
    const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];
    console.log(`🤖 AI Auto-Question Running: "${randomPrompt}"`);

    try {
        const response = await groqClient.chat.completions.create({
            messages: [{ role: "user", content: randomPrompt }],
            model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            temperature: 0.9,
            max_tokens: 1000,
        });

        let aiResponseText = response.choices[0]?.message?.content || "";
        if (!aiResponseText) return { totalAdded: 0, allGeneratedWords: [] };

        // Replace hyphens and underscores with spaces to split connected words
        aiResponseText = aiResponseText.replace(/[-_]/g, ' ');

        // Process words: Split, clean, and filter
        const tokens = aiResponseText.split(/\s+/); 
        const validWords = [];
        
        for (let t of tokens) {
            // Ignore emails and links
            if (t.includes('@') || /(http|www)/.test(t)) continue;
            
            // Remove symbols and numbers
            let cleaned = t.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase();
            
            // Keep pure alphabets only
            if (cleaned.length > 1 && /^[a-z]+$/.test(cleaned)) {
                validWords.push(cleaned);
            }
        }

        const uniqueValidWords = [...new Set(validWords)];
        let newlyAddedCount = 0;
        let newlyAddedWords = [];

        // Check db and add new words
        for (let word of uniqueValidWords) {
            const exists = await Word.findOne({ word: word });
            if (!exists) {
                await new Word({ word: word, source: 'ai' }).save();
                newlyAddedCount++;
                newlyAddedWords.push(word);
            }
        }

        console.log(`✅ Extracted ${uniqueValidWords.length} words. Added ${newlyAddedCount} NEW words to DB.`);
        return { totalAdded: newlyAddedCount, allGeneratedWords: newlyAddedWords };

    } catch (error) {
        console.error("❌ Auto-Question AI error:", error.message);
        return { totalAdded: 0, allGeneratedWords: [] };
    }
}

// Cleanup logic
async function performCleanup() {
    const words = await Word.find({});
    let processed = 0, deleted = 0, corrected = 0, splitWords = 0;
    let report = [];

    for (let doc of words) {
        processed++;
        let original = doc.word;
        let action = 'kept';
        let newWords = [];

        // Delete bad lengths or chars
        if (original.length > 20 || /[^a-z]/.test(original)) {
            await Word.findByIdAndDelete(doc._id);
            deleted++;
            report.push({ action: 'deleted (garbage)', original });
            continue;
        }

        // Fix repeated chars 
        let fixed = original.replace(/(.)\1{2,}/g, "$1$1");
        if (fixed !== original) {
            action = 'corrected';
            newWords = [fixed];
            
            await Word.findByIdAndDelete(doc._id);
            
            const exists = await Word.findOne({ word: fixed });
            if (!exists) {
                await new Word({ word: fixed, source: doc.source, timestamp: doc.timestamp }).save();
            }
            corrected++;
            report.push({ action, original, new: newWords });
        }
    }
    return { processed, deleted, corrected, splitWords, report };
}

// Schedulers
const AI_CRON_SCHEDULE = process.env.AI_CRON_SCHEDULE || "*/30 * * * *";

// Scheduled AI Generation
cron.schedule(AI_CRON_SCHEDULE, async () => {
    console.log(`🕒 Scheduled AI execution running...`);
    await autoAskQuestionAndExtractWords();
});

// Daily cleanup at 2:00 AM
cron.schedule('0 2 * * *', async () => {
    console.log('🧹 Running daily cleanup at 2:00 AM...');
    const result = await performCleanup();
    console.log(`Cleanup Done. Processed: ${result.processed}, Deleted: ${result.deleted}, Corrected: ${result.corrected}`);
});

// Run once on startup if DB is empty
setTimeout(async () => {
    const count = await Word.countDocuments({ source: 'ai' });
    if (count === 0) await autoAskQuestionAndExtractWords();
}, 5000);


// ==================== API ENDPOINTS ====================

app.post('/api/save_word', verifyApiKey, async (req, res) => {
    try {
        const { word } = req.body;
        if (!word) return res.status(400).json({ error: "Word required" });
        const existing = await Word.findOne({ word: word.toLowerCase() });
        if (existing) return res.json({ message: "Word exists" });
        await new Word({ word: word.toLowerCase(), source: 'user' }).save();
        res.json({ message: "Saved" });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/process_words', verifyApiKey, async (req, res) => {
    try {
        let { wordsText } = req.body;
        if (!wordsText) return res.status(400).json({ error: "No text" });
        
        // Convert hyphens and underscores to spaces to split connected words
        wordsText = wordsText.replace(/[-_]/g, ' ');
        const tokens = wordsText.split(/\s+/);
        
        const valid = [];
        for (let t of tokens) {
            if (t.includes('@') || /(http|www)/.test(t)) continue;
            let cleaned = t.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '').toLowerCase();
            if (cleaned.length > 1 && /^[a-z]+$/.test(cleaned)) valid.push(cleaned);
        }
        res.json({ processedWords: [...new Set(valid)] });
    } catch (err) { res.status(500).json({ error: "Processing failed" }); }
});

app.post('/api/save_processed_words', verifyApiKey, async (req, res) => {
    try {
        const { wordsList } = req.body;
        if (!Array.isArray(wordsList)) return res.status(400).json({ error: "Invalid" });
        let added = 0;
        for (let w of wordsList) {
            const exists = await Word.findOne({ word: w });
            if (!exists) {
                await new Word({ word: w, source: 'user' }).save();
                added++;
            }
        }
        res.json({ message: `Added ${added} user words` });
    } catch (err) { res.status(500).json({ error: "Save failed" }); }
});

app.get('/api/get_all_words', verifyApiKey, async (req, res) => {
    try {
        const all = await Word.find({}, 'word -_id');
        res.json({ words: all.map(o => o.word) });
    } catch (err) { res.status(500).json({ error: "Fetch failed" }); }
});

app.get('/api/status', async (req, res) => {
    try {
        const total = await Word.countDocuments();
        const totalAI = await Word.countDocuments({ source: 'ai' });
        const todayStart = getStartOfToday();
        const todayAI = await Word.countDocuments({ source: 'ai', timestamp: { $gte: todayStart } });
        res.json({
            serviceStatus: 'Active',
            databaseConnected: isDbConnected,
            totalWordsSaved: total,
            totalAIGenerated: totalAI,
            todayAIGenerated: todayAI
        });
    } catch (err) { res.status(500).json({ error: "Status error" }); }
});

app.post('/api/ai/manual_generate', verifyApiKey, async (req, res) => {
    try {
        const { totalAdded, allGeneratedWords } = await autoAskQuestionAndExtractWords();
        res.json({
            message: `AI added ${totalAdded} new Hinglish words from paragraph`,
            addedCount: totalAdded,
            generatedWords: allGeneratedWords
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ai/words', verifyApiKey, async (req, res) => {
    try {
        const aiWords = await Word.find({ source: 'ai' }, 'word timestamp -_id').sort({ timestamp: -1 }).limit(100);
        res.json({ words: aiWords });
    } catch (err) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/recent_activity', verifyApiKey, async (req, res) => {
    try {
        const recent = await Word.find({}, 'word source timestamp').sort({ timestamp: -1 }).limit(10);
        res.json({ activities: recent });
    } catch (err) { res.status(500).json({ error: "Failed to fetch recent activity" }); }
});

app.post('/api/run_cleanup', verifyApiKey, async (req, res) => {
    try {
        const result = await performCleanup();
        res.json(result);
    } catch (err) { 
        res.status(500).json({ error: "Cleanup processing failed: " + err.message }); 
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
