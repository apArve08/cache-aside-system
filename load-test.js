// load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const TARGET = Number(__ENV.TARGET || 500);   // start small, then use 3000

export const options = {
  stages: [
    { duration: '30s', target: TARGET },   // ramp up
    { duration: '30s', target: TARGET },   // hold
  ],
};

export default function () {
  // Same traffic for OFF and ON: 80% of requests hit 100 "popular" rows,
  // 20% hit any of the 20,000 rows.
  const id = Math.random() < 0.8
    ? Math.floor(Math.random() * 100) + 1
    : Math.floor(Math.random() * 20000) + 1;

  const res = http.get(`http://localhost:3000/logs/${id}`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}