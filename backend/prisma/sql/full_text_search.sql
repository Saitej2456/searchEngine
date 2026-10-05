ALTER TABLE "public"."question"
ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

UPDATE "public"."question"
SET "search_vector" =
    setweight(
        to_tsvector(
            'english',
            coalesce("title", '')
        ),
        'A'
    )
    ||
    setweight(
        to_tsvector(
            'english',
            coalesce(array_to_string("tags", ' '), '')
        ),
        'B'
    )
    ||
    setweight(
        to_tsvector(
            'english',
            coalesce("body", '')
        ),
        'C'
    )
WHERE "search_vector" IS NULL;

CREATE INDEX IF NOT EXISTS "question_search_vector_gin_idx"
ON "public"."question"
USING GIN ("search_vector");