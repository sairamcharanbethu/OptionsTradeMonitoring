-- Settings Table
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed defaults
INSERT INTO settings (key, value) VALUES 
('ai_provider', 'ollama'),
('ai_model', 'mistral:7b-instruct-q4_K_M'),
('openrouter_key', '')
ON CONFLICT (key) DO NOTHING;
