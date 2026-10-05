const fs = require("fs");

const TAGS = [
    "javascript",
    "typescript",
    "reactjs",
    "node.js",
    "express",
    "html",
    "css",
    "postgresql",
    "mysql",
    "git",
    "docker",
    "rest"
];

const QUESTIONS_PER_TAG = 2000;
const PAGE_SIZE = 100;
const MAX_PAGES = 25;

const DELAY_BETWEEN_REQUESTS = 200;

async function downloadQuestions() {
    const questions = [];
    const seenIds = new Set();

    let duplicateCount = 0;

    for (const tag of TAGS) {
        let page = 1;
        let hasMore = true;
        let tagQuestionCount = 0;

        console.log(`\nStarting tag: ${tag}`);

        while (
            tagQuestionCount < QUESTIONS_PER_TAG &&
            hasMore &&
            page <= MAX_PAGES
        ) {
            console.log(
                `Downloading ${tag} - page ${page}...`
            );

            const API_URL =
                "https://api.stackexchange.com/2.3/questions" +
                `?site=stackoverflow` +
                `&tagged=${encodeURIComponent(tag)}` +
                `&page=${page}` +
                `&pagesize=${PAGE_SIZE}` +
                `&filter=withbody`;

            const response = await fetch(API_URL);

            if (!response.ok) {
                throw new Error(
                    `API request failed for tag "${tag}" on page ${page}: ${response.status}`
                );
            }

            const data = await response.json();

            // Check if the API has asked us to back off.
            if (data.backoff) {
                console.log(
                    `API requested backoff for ${data.backoff} seconds.`
                );

                await sleep(data.backoff * 1000);
            }

            for (const question of data.items) {
                // Stop adding questions once this tag reaches its target.
                if (
                    tagQuestionCount >= QUESTIONS_PER_TAG
                ) {
                    break;
                }

                if (
                    !seenIds.has(question.question_id)
                ) {
                    seenIds.add(question.question_id);

                    questions.push({
                        question_id: question.question_id,
                        title: question.title,
                        body: question.body,
                        tags: question.tags,
                        score: question.score,
                        answer_count: question.answer_count,
                        view_count: question.view_count,
                        url: question.link,
                        content_license:
                            question.content_license
                    });

                    tagQuestionCount++;
                } else {
                    duplicateCount++;
                }
            }

            hasMore = data.has_more;
            page++;

            console.log(
                `${tag}: collected ${tagQuestionCount}/${QUESTIONS_PER_TAG} unique questions`
            );

            console.log(
                `Total unique questions so far: ${questions.length}`
            );

            console.log(
                `API quota remaining: ${data.quota_remaining}`
            );

            // Wait before making the next request.
            await sleep(DELAY_BETWEEN_REQUESTS);
        }

        if (tagQuestionCount < QUESTIONS_PER_TAG) {
            if (page > MAX_PAGES) {
                console.log(
                    `Reached the maximum of ${MAX_PAGES} pages for "${tag}".`
                );
            } else if (!hasMore) {
                console.log(
                    `No more results available for "${tag}".`
                );
            }
        }

        console.log(
            `Finished tag "${tag}" with ${tagQuestionCount} unique questions.`
        );
    }

    fs.writeFileSync(
        "data/stackoverflow.json",
        JSON.stringify(questions, null, 2)
    );

    console.log("\n----------------------");
    console.log("DOWNLOAD COMPLETE");
    console.log("----------------------");

    console.log(
        `Saved ${questions.length} unique questions.`
    );

    console.log(
        `Found ${duplicateCount} duplicate results.`
    );

    console.log(
        "Saved to data/stackoverflow.json"
    );
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

downloadQuestions();