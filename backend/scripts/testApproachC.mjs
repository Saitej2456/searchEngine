import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined. Add it to backend/.env before running tests.');
}

const sql = postgres(DATABASE_URL);
const TOP_RESULTS = 10;
const representativeQueries = [
  'react useeffect infinite loop',
  'python list comprehension',
  'sql join multiple tables',
  'python dictionary key error',
  'async await error handling',
  'javascript array',
];
const edgeCaseQueries = [
  '',
  '!!! ???',
  'python python PYTHON',
  'the and or',
  'python',
  'unfindabletermzxqv',
];

function compareRows(left, right) {
  return (
    right.title_matches - left.title_matches ||
    right.overall_matches - left.overall_matches ||
    left.relevance_band - right.relevance_band ||
    Number(right.custom_score) - Number(left.custom_score) ||
    Number(right.text_rank) - Number(left.text_rank) ||
    Number(left.question_id) - Number(right.question_id)
  );
}

function assertOrdering(rows, query) {
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRows(rows[index - 1], rows[index]) > 0) {
      throw new Error(`Ordering check failed for ${JSON.stringify(query)} at result ${index + 1}.`);
    }
  }
}

async function runSearch(query) {
  const rows = await sql`
    SELECT *
    FROM public.search_questions_approach_c(${query}, ${TOP_RESULTS});
  `;
  assertOrdering(rows, query);
  console.log(`\nSearch: ${JSON.stringify(query)} (${rows.length} result(s))`);
  console.table(rows.map((row) => ({
    ...row,
    question_id: String(row.question_id),
    text_rank: Number(row.text_rank).toFixed(6),
    custom_score: Number(row.custom_score).toFixed(6),
  })));
}

async function verifyCorpusIntegrity() {
  const [summary] = await sql`
    SELECT
      count(*)::integer AS question_count,
      count(search_vector)::integer AS search_vectors_present,
      count(custom_score)::integer AS custom_scores_present
    FROM public.question;
  `;
  console.log('Corpus check:', summary);
}

async function explain(query) {
  const plan = await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT *
    FROM public.search_questions_approach_c(${query}, ${TOP_RESULTS});
  `;
  console.log(`\nEXPLAIN (ANALYZE, BUFFERS): ${JSON.stringify(query)}`);
  console.log(plan.map((row) => row['QUERY PLAN']).join('\n'));
}

async function explainCandidateRetrieval(query) {
  // This is the same normalized OR-query and indexed candidate predicate used
  // by the function. Explaining it directly exposes the underlying scan choice.
  const plan = await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    WITH normalized_terms AS MATERIALIZED (
      SELECT term, to_tsquery('simple', quote_literal(term)) AS term_query
      FROM (
        SELECT DISTINCT unnest(
          tsvector_to_array(to_tsvector('english', coalesce(${query}, '')))
        ) AS term
      ) AS distinct_terms
    ),
    search_query AS MATERIALIZED (
      SELECT to_tsquery('simple', string_agg(quote_literal(term), ' | ' ORDER BY term)) AS or_query
      FROM normalized_terms
    )
    SELECT q.question_id
    FROM public.question AS q
    CROSS JOIN search_query AS sq
    WHERE sq.or_query IS NOT NULL
      AND q.search_vector @@ sq.or_query;
  `;
  const planText = plan.map((row) => row['QUERY PLAN']).join('\n');
  console.log(`\nCandidate retrieval EXPLAIN (ANALYZE, BUFFERS): ${JSON.stringify(query)}`);
  console.log(planText);
  console.log(
    planText.includes('question_search_vector_gin_idx')
      ? 'GIN index usage: yes'
      : 'GIN index usage: no (the planner selected another valid access path)'
  );
}

try {
  await verifyCorpusIntegrity();
  for (const query of representativeQueries) await runSearch(query);
  for (const query of edgeCaseQueries) await runSearch(query);
  await explain('react useeffect infinite loop');
  await explain('python');
  await explainCandidateRetrieval('react useeffect infinite loop');
  await explainCandidateRetrieval('python');
  console.log('\nApproach C tests passed: result ordering is valid.');
} finally {
  await sql.end();
}
