-- Add ttft_ms to call_logs summary table for TTFT observability
ALTER TABLE call_logs ADD COLUMN ttft_ms INTEGER DEFAULT NULL;
