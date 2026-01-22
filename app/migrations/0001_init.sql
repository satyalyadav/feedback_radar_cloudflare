-- Create feedback table
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sentiment TEXT,
    urgency INTEGER,
    tags TEXT,
    summary TEXT,
    ai_model TEXT,
    ai_latency_ms INTEGER,
    analysis_status TEXT DEFAULT 'pending',
    analysis_error TEXT
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);
