require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true }
});

pool.connect((err, client, release) => {
    if (err) console.error('❌ Error connecting to NeonDB:', err.stack);
    else { console.log('✅ Successfully connected to NeonDB'); release(); }
});

const USER_ID = 1;

const getDaysDifference = (date1, date2) => Math.floor(Math.abs(date2 - date1) / (1000 * 60 * 60 * 24));

// --- API Routes ---

// 1. Get Stats (Real 7-Day Activity)
app.get('/api/stats', async (req, res) => {
    try {
        const userRes = await pool.query('SELECT streak_points, last_answered_date FROM users WHERE id = $1', [USER_ID]);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let streakPoints = 0;

        // Calculate missed days penalty
        if (userRes.rowCount > 0) {
            let user = userRes.rows[0];
            streakPoints = user.streak_points;

            if (user.last_answered_date) {
                const lastDate = new Date(user.last_answered_date);
                lastDate.setHours(0, 0, 0, 0);
                const daysMissed = getDaysDifference(lastDate, today) - 1;
                
                if (daysMissed > 0) {
                    streakPoints = Math.max(0, streakPoints - (daysMissed * 5));
                    await pool.query('UPDATE users SET streak_points = $1 WHERE id = $2', [streakPoints, USER_ID]);
                }
            }
        }

        // Fetch actual activity for the past 7 days from the answers table
        const activeDatesRes = await pool.query(`
            SELECT DISTINCT DATE(answered_at) as adate
            FROM answers
            WHERE user_id = $1 AND answered_at >= CURRENT_DATE - INTERVAL '6 days'
        `, [USER_ID]);

        // Format dates to YYYY-MM-DD for easy comparison
        const activeDates = activeDatesRes.rows.map(row => {
            const d = new Date(row.adate);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        });

        // Generate the past 7 days array for the UI
        const past7Days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            
            const dateString = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
            
            past7Days.push({
                day: dayName,
                active: activeDates.includes(dateString) // true = green, false = red
            });
        }

        res.json({ points: streakPoints, past7Days });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// 2. Get Random Question
app.get('/api/question/random', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM questions 
            WHERE id NOT IN (SELECT question_id FROM answers WHERE user_id = $1)
            ORDER BY RANDOM() LIMIT 1
        `, [USER_ID]);
        if (result.rowCount === 0) return res.json({ id: null, question_text: "🎉 Amazing! You have answered every single question!" });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch question' }); }
});

// 3. Submit Answer
app.post('/api/answer', async (req, res) => {
    const { questionId, answerText } = req.body;
    try {
        if (questionId && answerText) {
            await pool.query('INSERT INTO answers (user_id, question_id, answer_text) VALUES ($1, $2, $3)', [USER_ID, questionId, answerText]);
            await pool.query('UPDATE users SET streak_points = streak_points + 10, last_answered_date = CURRENT_DATE WHERE id = $1', [USER_ID]);
            res.json({ success: true, message: "Answer saved! +10 Points!" });
        } else { res.status(400).json({ error: 'Missing data.' }); }
    } catch (err) { res.status(500).json({ error: 'Failed to submit answer' }); }
});

// 4. Get Answer History
app.get('/api/answers/history', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.id as answer_id, q.question_text, a.answer_text, a.answered_at
            FROM answers a
            JOIN questions q ON a.question_id = q.id
            WHERE a.user_id = $1
            ORDER BY a.answered_at DESC
        `, [USER_ID]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch history' }); }
});

// 5. Update an Answer
app.put('/api/answers/:id', async (req, res) => {
    const { id } = req.params;
    const { answerText } = req.body;
    try {
        await pool.query('UPDATE answers SET answer_text = $1 WHERE id = $2 AND user_id = $3', [answerText, id, USER_ID]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update answer' }); }
});

// 6. Delete an Answer
app.delete('/api/answers/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM answers WHERE id = $1 AND user_id = $2', [id, USER_ID]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete answer' }); }
});

app.use((req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server is running on http://localhost:${PORT}`));