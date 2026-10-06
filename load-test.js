// load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const TARGET   = Number(__ENV.TARGET || 500);
const ENDPOINT = __ENV.ENDPOINT || 'single';       // 'single' or 'list'
const THINK    = Number(__ENV.THINK ?? 0.1);       // seconds between requests

export const options = {
  stages: [
    { duration: '30s', target: TARGET },
    { duration: '30s', target: TARGET },
  ],
};

export default function () {
  let url;
  if (ENDPOINT === 'list') {
    url = `http://localhost:3000/logs?page=${Math.floor(Math.random() * 20) + 1}`;
  } else {
    const id = Math.random() < 0.8
      ? Math.floor(Math.random() * 100) + 1
      : Math.floor(Math.random() * 20000) + 1;
    url = `http://localhost:3000/logs/${id}`;
  }

  // tags.name groups all URLs into one metric series (removes the warning)
  const res = http.get(url, { tags: { name: ENDPOINT } });

  check(res, {
    'status 200': (r) => r.status === 200,
    'list returned a full page': (r) => ENDPOINT !== 'list' || r.body.length > 1000,
  });
  sleep(THINK);
}