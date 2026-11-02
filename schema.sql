CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'paper_arbitrage_scan',
  amount REAL NOT NULL DEFAULT 0,
  token_symbol TEXT NOT NULL DEFAULT 'SOL/USDC',
  tx_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PAPER_NO_PROFIT',
  meta TEXT,
  sender_address TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
