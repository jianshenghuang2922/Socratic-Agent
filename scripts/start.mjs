/**
 * 启动包装器 —— 唯一目的是把端口和监听地址从环境变量里读出来。
 *
 * 为什么不直接在 package.json 里写 `next start -H 0.0.0.0 -p $PORT`：
 * 部分部署环境的 shell 不展开 `$PORT`，会把字面量 `$PORT` 传给参数解析器，
 * 于是 `next start` 直接报参数错误。在这里用 process.env 读，行为稳定得多。
 *
 * Next.js 本身认得 PORT / HOSTNAME，但显式传参更可控（也便于本地覆盖）。
 */
import { spawn } from 'node:child_process';

const port = process.env.PORT || '3000';
// 云平台通常要求监听 0.0.0.0 才能被反向代理访问；本地默认同样是 0.0.0.0 也无副作用
const host = process.env.HOSTNAME_BIND || process.env.HOST || '0.0.0.0';

console.log(`[start] next start -H ${host} -p ${port}`);

const child = spawn('npx', ['next', 'start', '-H', host, '-p', String(port)], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[start] 启动失败：', err);
  process.exit(1);
});
