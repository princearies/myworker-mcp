ALTER TABLE transactions ADD COLUMN type TEXT NOT NULL DEFAULT 'paper_arbitrage_scan';
ALTER TABLE transactions ADD COLUMN token_symbol TEXT NOT NULL DEFAULT 'SOL/USDC';
ALTER TABLE transactions ADD COLUMN meta TEXT;
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
