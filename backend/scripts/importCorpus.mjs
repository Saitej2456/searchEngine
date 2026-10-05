import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
/*
 * Stack Overflow Corpus Importer
 *
 * Pipeline:
 *
 * JSON corpus
 *    ↓
 * Validate / clean records
 *    ↓
 * Calculate percentile ranks
 *    ↓
 * S = score percentile
 * A = answer_count percentile
 * V = view_count percentile
 *    ↓
 * custom_score = (S + A + V) / 3
 *    ↓
 * PostgreSQL
 */

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not defined.");
    console.error("Make sure backend/.env contains DATABASE_URL.");
    process.exit(1);
}

// Our corpus is outside backend/.
// backend/scripts/importCorpus.mjs
//       ↑
//       └── ../../data/<corpus>.json
//
// Change this filename if your JSON file has a different name.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CORPUS_PATH = path.resolve(
    __dirname,
    "../../data/questions.json"
);


// Number of rows inserted in each database batch.
const BATCH_SIZE = 500;

// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------

function fail(message) {
    console.error(`\nERROR: ${message}`);
    process.exit(1);
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function cleanString(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim();
}

function cleanTags(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean);
}

// -----------------------------------------------------------------------------
// Percentile calculation
// -----------------------------------------------------------------------------

/*
 * Returns the percentile rank of `value` inside `sortedValues`.
 *
 * Result:
 *
 *     0.0  → bottom of the corpus
 *     0.5  → around the middle
 *     1.0  → top of the corpus
 *
 * We use the average rank for tied values.
 *
 * Example:
 *
 * scores = [-4, -2, 0, 0, 1, 2, 10]
 *
 * score = 0
 *
 * There are two zeros, so they share the average rank.
 */
function percentileRank(value, sortedValues) {
    const n = sortedValues.length;

    if (n <= 1) {
        return 0.5;
    }

    let lessThan = 0;
    let equalTo = 0;

    for (const current of sortedValues) {
        if (current < value) {
            lessThan++;
        } else if (current === value) {
            equalTo++;
        }
    }

    /*
     * Average rank of all tied values.
     *
     * Convert from 1-based rank to [0,1].
     */
    const averageRank =
        lessThan + (equalTo + 1) / 2;

    return (averageRank - 1) / (n - 1);
}

// -----------------------------------------------------------------------------
// Corpus loading
// -----------------------------------------------------------------------------

async function loadCorpus() {
    console.log(`Reading corpus: ${CORPUS_PATH}`);

    let raw;

    try {
        raw = await fs.readFile(CORPUS_PATH, "utf8");
    } catch (error) {
        fail(
            `Could not read corpus file.\n` +
            `Expected location:\n${CORPUS_PATH}\n\n` +
            `Original error: ${error.message}`
        );
    }

    let parsed;

    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        fail(`The corpus is not valid JSON: ${error.message}`);
    }

    /*
     * Support either:
     *
     * [
     *   {...},
     *   {...}
     * ]
     *
     * or:
     *
     * {
     *   "items": [...]
     * }
     */
    let records;

    if (Array.isArray(parsed)) {
        records = parsed;
    } else if (Array.isArray(parsed.items)) {
        records = parsed.items;
    } else if (Array.isArray(parsed.questions)) {
        records = parsed.questions;
    } else {
        fail(
            "Could not find the question array in the JSON file. " +
            "Expected an array or an object containing `items` or `questions`."
        );
    }

    console.log(`Loaded ${records.length} records.`);

    return records;
}

// -----------------------------------------------------------------------------
// Validation / cleaning
// -----------------------------------------------------------------------------

function validateAndClean(records) {
    const cleaned = [];
    const invalid = [];

    const seenQuestionIds = new Set();

    for (let index = 0; index < records.length; index++) {
        const record = records[index];

        if (!record || typeof record !== "object") {
            invalid.push({
                index,
                reason: "record is not an object",
            });

            continue;
        }

        const questionId = Number(record.question_id);

        const title = cleanString(record.title);
        const body = typeof record.body === "string"
            ? record.body
            : "";

        const tags = cleanTags(record.tags);

        const score = Number(record.score);
        const answerCount = Number(record.answer_count);
        const viewCount = Number(record.view_count);

        // Required fields
        if (!Number.isInteger(questionId) || questionId <= 0) {
            invalid.push({
                index,
                question_id: record.question_id,
                reason: "invalid question_id",
            });

            continue;
        }

        if (seenQuestionIds.has(questionId)) {
            invalid.push({
                index,
                question_id: questionId,
                reason: "duplicate question_id",
            });

            continue;
        }

        if (!title) {
            invalid.push({
                index,
                question_id: questionId,
                reason: "missing title",
            });

            continue;
        }

        if (!body) {
            invalid.push({
                index,
                question_id: questionId,
                reason: "missing body",
            });

            continue;
        }

        if (!isFiniteNumber(score)) {
            invalid.push({
                index,
                question_id: questionId,
                reason: "invalid score",
            });

            continue;
        }

        if (!Number.isInteger(answerCount) || answerCount < 0) {
            invalid.push({
                index,
                question_id: questionId,
                reason: "invalid answer_count",
            });

            continue;
        }

        if (!Number.isInteger(viewCount) || viewCount < 0) {
            invalid.push({
                index,
                question_id: questionId,
                reason: "invalid view_count",
            });

            continue;
        }

        seenQuestionIds.add(questionId);

        cleaned.push({
            question_id: questionId,
            title,
            body,
            tags,
            score,
            answer_count: answerCount,
            view_count: viewCount,

            url:
                typeof record.url === "string" && record.url.trim()
                    ? record.url.trim()
                    : null,

            content_license:
                typeof record.content_license === "string" &&
                record.content_license.trim()
                    ? record.content_license.trim()
                    : null,
        });
    }

    return {
        cleaned,
        invalid,
    };
}

// -----------------------------------------------------------------------------
// Custom score calculation
// -----------------------------------------------------------------------------

function calculateCustomScores(records) {
    const scores = records
        .map((record) => record.score)
        .sort((a, b) => a - b);

    const answerCounts = records
        .map((record) => record.answer_count)
        .sort((a, b) => a - b);

    const viewCounts = records
        .map((record) => record.view_count)
        .sort((a, b) => a - b);

    console.log("\nCalculating percentile ranks...");

    return records.map((record) => {
        /*
         * Negative scores require no special penalty.
         *
         * Example:
         *
         * score = -4
         *     ↓
         * low percentile
         *     ↓
         * low S value
         *
         * Positive scores similarly get their natural position
         * within the corpus.
         */
        const S = percentileRank(record.score, scores);

        const A = percentileRank(
            record.answer_count,
            answerCounts
        );

        const V = percentileRank(
            record.view_count,
            viewCounts
        );

        /*
         * Equal weighting.
         *
         * Every normalized signal contributes exactly 1/3.
         */
        const customScore = (S + A + V) / 3;

        return {
            ...record,
            custom_score: customScore,
        };
    });
}

// -----------------------------------------------------------------------------
// Database insertion
// -----------------------------------------------------------------------------

async function insertRecords(records) {
    console.log("\nConnecting to PostgreSQL...");

    const sql = postgres(DATABASE_URL);

    try {
        /*
         * Make sure the table exists before importing.
         */
        const tableCheck = await sql`
            SELECT to_regclass('public.question') AS table_name;
        `;

        if (!tableCheck[0]?.table_name) {
            fail(
                'Table "public.question" does not exist.\n' +
                "Run your Prisma migration first."
            );
        }

        console.log('Found table "public.question".');

        /*
         * We use INSERT ... ON CONFLICT DO UPDATE.
         *
         * Therefore the importer can safely be run again.
         *
         * question_id is the natural Stack Overflow identifier,
         * while our internal `id` remains PostgreSQL-generated.
         */
        let inserted = 0;

        for (let i = 0; i < records.length; i += BATCH_SIZE) {
            const batch = records.slice(i, i + BATCH_SIZE);

            await sql.begin(async (transaction) => {
                for (const record of batch) {
                    await transaction`
                        INSERT INTO public.question (
                            question_id,
                            title,
                            body,
                            tags,
                            score,
                            answer_count,
                            view_count,
                            url,
                            content_license,
                            custom_score
                        )
                        VALUES (
                            ${record.question_id},
                            ${record.title},
                            ${record.body},
                            ${transaction.array(record.tags)},
                            ${record.score},
                            ${record.answer_count},
                            ${record.view_count},
                            ${record.url},
                            ${record.content_license},
                            ${record.custom_score}
                        )
                        ON CONFLICT (question_id)
                        DO UPDATE SET
                            title = EXCLUDED.title,
                            body = EXCLUDED.body,
                            tags = EXCLUDED.tags,
                            score = EXCLUDED.score,
                            answer_count = EXCLUDED.answer_count,
                            view_count = EXCLUDED.view_count,
                            url = EXCLUDED.url,
                            content_license = EXCLUDED.content_license,
                            custom_score = EXCLUDED.custom_score
                    `;
                }
            });

            inserted += batch.length;

            const percentage =
                ((inserted / records.length) * 100).toFixed(1);

            console.log(
                `Imported ${inserted}/${records.length} (${percentage}%)`
            );
        }

        console.log(
            `\nSuccessfully imported ${inserted} question(s).`
        );
    } finally {
        await sql.end();
    }
}

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

async function verifyDatabase() {
    const sql = postgres(DATABASE_URL);

    try {
        const result = await sql`
            SELECT
                COUNT(*)::integer AS count,
                MIN(custom_score) AS min_custom_score,
                MAX(custom_score) AS max_custom_score,
                AVG(custom_score) AS avg_custom_score
            FROM public.question;
        `;

        const stats = result[0];

        console.log("\nDatabase verification:");
        console.log(`  Questions: ${stats.count}`);
        console.log(
            `  Minimum custom_score: ${Number(stats.min_custom_score).toFixed(6)}`
        );
        console.log(
            `  Maximum custom_score: ${Number(stats.max_custom_score).toFixed(6)}`
        );
        console.log(
            `  Average custom_score: ${Number(stats.avg_custom_score).toFixed(6)}`
        );
    } finally {
        await sql.end();
    }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
    console.log("========================================");
    console.log(" Stack Overflow Corpus Importer");
    console.log("========================================");

    const records = await loadCorpus();

    if (records.length === 0) {
        fail("The corpus contains no records.");
    }

    const {
        cleaned,
        invalid,
    } = validateAndClean(records);

    console.log("\nValidation:");
    console.log(`  Valid records:   ${cleaned.length}`);
    console.log(`  Invalid records: ${invalid.length}`);

    if (invalid.length > 0) {
        console.log("\nInvalid records:");

        for (const item of invalid.slice(0, 20)) {
            console.log(
                `  [${item.index}] ` +
                `question_id=${item.question_id ?? "unknown"}: ` +
                item.reason
            );
        }

        if (invalid.length > 20) {
            console.log(
                `  ...and ${invalid.length - 20} more`
            );
        }
    }

    if (cleaned.length === 0) {
        fail("No valid records remain after validation.");
    }

    const recordsWithScores =
        calculateCustomScores(cleaned);

    await insertRecords(recordsWithScores);

    await verifyDatabase();

    console.log("\n========================================");
    console.log(" Import completed successfully.");
    console.log("========================================");
}

main().catch((error) => {
    console.error("\nIMPORT FAILED");
    console.error(error);
    process.exit(1);
});