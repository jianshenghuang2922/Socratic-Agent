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
// 云平台（Zeabur / Railway / Render 等）要求监听 0.0.0.0 才能被反向代理访问；
// 本地默认 0.0.0.0 同样无副作用。
//
// 只认自定义的 HOSTNAME_BIND，**不要读 process.env.HOST**：
// 容器里 HOST 常被平台设成别的东西（主机名、外部域名等），
// 拿来当监听地址会直接绑不上、启动失败。
const host = process.env.HOSTNAME_BIND || '0.0.0.0';

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
