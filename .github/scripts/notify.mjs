// Sends the RollerCalc push notifications (FCM data messages to topics).
//
// push:              new event  -> a progression-event-list/<path>/response.json was added
//                    new miners -> miner-list/details.json count went up
// workflow_dispatch: sends the message of the inputs (to the debug_ topics if INPUT_DEBUG=true)
//
// The message format must match the app (NotificationType and RollerCalcMessagingService):
//   new_event  -> data { type, name, path }
//   new_miners -> data { type, count }
//
// Env: FIREBASE_SERVICE_ACCOUNT (JSON), GITHUB_EVENT_NAME, BEFORE, AFTER,
//      INPUT_TYPE, INPUT_NAME, INPUT_PATH, INPUT_COUNT, INPUT_DEBUG

import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';

const PAGES_URL = 'https://cobogames.github.io/rollercalc-res';
const EVENTS_DIR = 'progression-event-list';
const MINER_DETAILS = 'miner-list/details.json';

// GitHub Pages takes a while to publish the push, wait so that the app finds the new data
const PAGES_WAIT_MS = 10 * 60 * 1000;
const PAGES_POLL_MS = 20 * 1000;

const env = process.env;

// region HELPERS

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the parsed JSON of a file at a commit, or null if it doesn't exist. */
function readJsonAt(commit, file) {
    try {
        return JSON.parse(stripBom(git('show', `${commit}:${file}`)));
    } catch {
        return null;
    }
}

const stripBom = (text) => text.replace(/^﻿/, '');

/** Waits until [url] returns 200 and [isReady] accepts its JSON. Returns false on timeout. */
async function waitForPages(url, isReady = () => true) {
    const end = Date.now() + PAGES_WAIT_MS;
    while (Date.now() < end) {
        try {
            const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
            if (res.ok && isReady(JSON.parse(stripBom(await res.text())))) return true;
            console.log(`Waiting for GitHub Pages: ${url} (HTTP ${res.status})`);
        } catch (e) {
            console.log(`Waiting for GitHub Pages: ${url} (${e.message})`);
        }
        await sleep(PAGES_POLL_MS);
    }
    return false;
}

// endregion

// region FCM

/** OAuth access token for FCM signing a JWT with the service account key. */
async function getAccessToken(account) {
    const now = Math.floor(Date.now() / 1000);
    const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

    const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${unsigned}.${signature}`,
        }),
    });
    if (!res.ok) throw new Error(`Google token error: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
}

async function send(fcm, topic, data) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fcm.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                topic,
                // FCM data values must be strings
                data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
                android: { priority: 'high' },
            },
        }),
    });
    if (!res.ok) throw new Error(`FCM error (${topic}): HTTP ${res.status} ${await res.text()}`);
    console.log(`Sent to ${topic}: ${JSON.stringify(data)}`);
}

// endregion

// region MESSAGES

/** Messages for the events added between [before] and [after]. */
async function newEventMessages(before, after) {
    const added = git('diff', '--name-only', '--diff-filter=A', before, after, '--', EVENTS_DIR)
        .split('\n')
        .filter((file) => file.endsWith('/response.json'))
        .map((file) => file.split('/')[1]);

    const index = readJsonAt(after, `${EVENTS_DIR}/index.json`);
    const list = index?.data?.list ?? [];

    const messages = [];
    for (const path of added) {
        const name = list.find((event) => event.path === path)?.name ?? '';

        if (!(await waitForPages(`${PAGES_URL}/${EVENTS_DIR}/${path}/response.json`))) {
            console.log(`Skipped '${path}': not published in GitHub Pages`);
            continue;
        }
        messages.push({ type: 'new_event', name, path });
    }
    return messages;
}

/** Message for the miners added between [before] and [after], or null. */
async function newMinersMessage(before, after) {
    const oldCount = readJsonAt(before, MINER_DETAILS)?.data?.count;
    const newCount = readJsonAt(after, MINER_DETAILS)?.data?.count;
    if (typeof oldCount !== 'number' || typeof newCount !== 'number' || newCount <= oldCount) return null;

    const isPublished = await waitForPages(
        `${PAGES_URL}/${MINER_DETAILS}`,
        (json) => json?.data?.count >= newCount,
    );
    if (!isPublished) {
        console.log('Skipped new miners: not published in GitHub Pages');
        return null;
    }
    return { type: 'new_miners', count: newCount - oldCount };
}

function manualMessage() {
    switch (env.INPUT_TYPE) {
        case 'new_event':
            return { type: 'new_event', name: env.INPUT_NAME ?? '', path: env.INPUT_PATH ?? '' };
        case 'new_miners':
            return { type: 'new_miners', count: Number(env.INPUT_COUNT) || 0 };
        default:
            throw new Error(`Unknown type: ${env.INPUT_TYPE}`);
    }
}

// endregion

async function main() {
    let messages;
    let topicPrefix = '';

    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
        messages = [manualMessage()];
        if (env.INPUT_DEBUG === 'true') topicPrefix = 'debug_';
    } else {
        const { BEFORE: before, AFTER: after } = env;
        // first push of a branch: there is nothing to compare with
        if (!before || /^0+$/.test(before)) {
            console.log('No previous commit, nothing to notify');
            return;
        }
        messages = await newEventMessages(before, after);
        const miners = await newMinersMessage(before, after);
        if (miners) messages.push(miners);
    }

    if (messages.length === 0) {
        console.log('Nothing to notify');
        return;
    }

    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing secret FIREBASE_SERVICE_ACCOUNT');
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const fcm = { projectId: account.project_id, token: await getAccessToken(account) };

    for (const message of messages) await send(fcm, topicPrefix + message.type, message);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
