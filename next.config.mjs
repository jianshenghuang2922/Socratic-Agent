/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 云上部署时平台只给一个 PORT，且要求监听 0.0.0.0；
  // 在配置里读环境变量比在 startCmd 里写 $PORT 稳妥（部分环境不展开 shell 变量）。
  ...(process.env.PORT
    ? { port: Number(process.env.PORT), hostname: '0.0.0.0' }
    : {}),
};

export default nextConfig;
