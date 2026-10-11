-- Approach C: reusable, parameterized Stack Overflow question search.
--
-- Search text is first converted to an English tsvector.  Its distinct lexemes
-- are then used to build an OR tsquery with the "simple" configuration.  This
-- does not re-stem already-normalized lexemes, while matching exactly the
-- lexemes produced by PostgreSQL's English configuration.
CREATE OR REPLACE FUNCTION public.search_questions_approach_c(
    p_search_text text,
    p_limit integer DEFAULT 50,
    p_band_factor double precision DEFAULT 1.05
)
RETURNS TABLE (
    question_id bigint,
    title text,
    title_matches integer,
    overall_matches integer,
    text_rank real,
    relevance_band integer,
    custom_score double precision
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF p_band_factor IS NULL OR p_band_factor <= 1.0 THEN
        RAISE EXCEPTION 'p_band_factor must be greater than 1; received %', p_band_factor
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH normalized_terms AS MATERIALIZED (
        SELECT
            term,
            to_tsquery('simple', quote_literal(term)) AS term_query
        FROM (
            SELECT DISTINCT unnest(
                tsvector_to_array(
                    to_tsvector('english', coalesce(p_search_text, ''))
                )
            ) AS term
        ) AS distinct_terms
    ),
    search_query AS MATERIALIZED (
        SELECT to_tsquery(
            'simple',
            string_agg(quote_literal(term), ' | ' ORDER BY term)
        ) AS or_query
        FROM normalized_terms
    ),
    -- This is the indexed candidate-retrieval step.  The remaining work runs
    -- only for rows that match at least one normalized search term.
    candidates AS MATERIALIZED (
        SELECT q.question_id, q.title, q.search_vector, q.custom_score,
               to_tsvector('english', q.title) AS title_vector,
               sq.or_query
        FROM public.question AS q
        CROSS JOIN search_query AS sq
        WHERE sq.or_query IS NOT NULL
          AND q.search_vector @@ sq.or_query
    ),
    scored AS MATERIALIZED (
        SELECT
            c.question_id,
            c.title,
            (
                SELECT count(*)::integer
                FROM normalized_terms AS nt
                WHERE c.title_vector @@ nt.term_query
            ) AS title_matches,
            (
                SELECT count(*)::integer
                FROM normalized_terms AS nt
                WHERE c.search_vector @@ nt.term_query
            ) AS overall_matches,
            ts_rank_cd(c.search_vector, c.or_query, 32) AS text_rank,
            c.custom_score
        FROM candidates AS c
    ),
    banded AS (
        SELECT
            s.*,
            max(s.text_rank) OVER (
                PARTITION BY s.title_matches, s.overall_matches
            ) AS max_text_rank
        FROM scored AS s
    )
    SELECT
        b.question_id,
        b.title,
        b.title_matches,
        b.overall_matches,
        b.text_rank,
        CASE
            WHEN b.text_rank > 0 AND b.max_text_rank > 0
                THEN floor(
                    ln(b.max_text_rank / b.text_rank) / ln(p_band_factor)
                )::integer
            ELSE 0
        END AS relevance_band,
        b.custom_score
    FROM banded AS b
    ORDER BY
        b.title_matches DESC,
        b.overall_matches DESC,
        CASE
            WHEN b.text_rank > 0 AND b.max_text_rank > 0
                THEN floor(
                    ln(b.max_text_rank / b.text_rank) / ln(p_band_factor)
                )::integer
            ELSE 0
        END ASC,
        b.custom_score DESC,
        b.text_rank DESC,
        b.question_id ASC
    LIMIT GREATEST(coalesce(p_limit, 50), 0);
END;
$$;
