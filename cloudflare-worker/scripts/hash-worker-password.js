import { createWorkerPasswordHash } from '../src/worker-crypto.js';

const password = process.argv[2];
const secret = process.argv[3];

if (!password || !secret) {
  console.error('用法: npm run password:hash -- "应用访问密码" "ROUTE_SESSION_SECRET"');
  process.exitCode = 1;
} else {
  try {
    console.log(await createWorkerPasswordHash(password, { secret }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
