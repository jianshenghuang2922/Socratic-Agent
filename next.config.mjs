/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 端口与监听地址交给 `next start` 自己处理：
  // 它内置 `-p, --port`（默认 3000，且会读 PORT 环境变量）与 `-H, --hostname`（默认 0.0.0.0）。
  // 注意：`port` / `hostname` **不是** next.config 的合法键，写在这里会被忽略并告警
  // （Unrecognized key(s) in object），所以不要往这里加。
};

export default nextConfig;
