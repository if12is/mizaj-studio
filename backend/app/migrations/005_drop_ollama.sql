-- Ollama / local-LLM integration was removed: drop its leftover settings (harmless if absent).
DELETE FROM settings WHERE key = 'online_ollama' OR key LIKE 'ollama\_%' ESCAPE '\';
