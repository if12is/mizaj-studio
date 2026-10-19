-- Per-project override of the final-ya style («الياء آخر الكلمة»); NULL = follow the global setting.
ALTER TABLE projects ADD COLUMN ya_style TEXT
    CHECK (ya_style IS NULL OR ya_style IN ('standard', 'egyptian'));
