CREATE TABLE logs (
    id SERIAL PRIMARY KEY, 
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW()

);