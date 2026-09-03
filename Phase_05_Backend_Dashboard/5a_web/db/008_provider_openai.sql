-- SDIGF Phase 05c — db/008_provider_openai.sql
--
-- Widen the provider list to include OpenAI. Runs against sdigf_backend,
-- after 007.
--
-- "008" is the EIGHTH FILE IN THIS DIRECTORY (see migration-note.txt).
--
-- Decision: both providers are supported for adaptability. Each has its own
-- adapter in services/chat-service.js because their tool-calling wire shapes
-- differ (Anthropic: tool_use content blocks; OpenAI: tool_calls on the
-- assistant message). Everything above the adapter — brief, tools, guard —
-- is provider-independent, which is what makes this a CHECK widening and
-- not a redesign.

BEGIN;

ALTER TABLE provider_settings DROP CONSTRAINT IF EXISTS provider_settings_provider_check;

ALTER TABLE provider_settings ADD CONSTRAINT provider_settings_provider_check
  CHECK (provider IN ('anthropic', 'openai'));

COMMIT;

-- VERIFY
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conname = 'provider_settings_provider_check';
-- -- CHECK ((provider = ANY (ARRAY['anthropic'::text, 'openai'::text])))
