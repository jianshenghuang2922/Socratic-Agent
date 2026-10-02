'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 全屏循环播放的背景视频层。
 *
 * - 固定铺满视口、置于所有内容之下（z-index: -1）
 * - 自动播放 / 静音 / 循环 / playsInline，附 poster 避免首帧闪白
 * - 尊重 prefers-reduced-motion：用户关闭动效时暂停视频，只留静态帧
 * - 视频加载失败时自动降级为 poster 背景，不影响内容可读性
 */
export function BackgroundVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    // React 的 muted 属性在 hydration 后可能丢失，这里强制一次，否则浏览器会拒绝自动播放
    el.muted = true;
    el.defaultMuted = true;

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      if (mq.matches) {
        el.pause();
      } else {
        void el.play().catch(() => {
          /* 自动播放被策略拦截时静默降级，poster 仍在 */
        });
      }
    };

    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return (
    <div className="bg" aria-hidden="true">
      {!failed && (
        /*
         * transform 必须放在这层 wrapper 上，不能直接加在 <video> 上。
         * video 一旦带 transform（尤其配 will-change）就会被丢进独立合成层，
         * 逐帧更新时「视频固有尺寸 → 层尺寸」的映射会累积亚像素误差，
         * 播放一段时间后画面出现整体偏移。wrapper 的几何由布局决定，不受帧率影响。
         */
        <div className="bg__frame">
          <video
            ref={videoRef}
            className="bg__video"
            src="/bg-loop.mp4"
            poster="/bg-poster.jpg"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            onError={() => setFailed(true)}
          />
        </div>
      )}
      {/* 压暗层：保证前景文字对比度 */}
      <div className="bg__scrim" />
      {/* 暗角：让视线聚焦到中间的对话区 */}
      <div className="bg__vignette" />
      {/* 顶部与底部渐隐，让吸顶栏 / 输入区自然融入背景 */}
      <div className="bg__edges" />
    </div>
  );
}
