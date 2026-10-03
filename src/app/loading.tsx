/**
 * 路由级加载态。
 *
 * 没有它时，页面在服务端渲染/数据准备期间是完全静止的，用户会以为卡住了。
 * 这里的骨架刻意做得极轻——真正的等待主要发生在建立上下文（克隆仓库可能几十秒），
 * 那段时间由 page.tsx 里的「正在解析 URL 内容…」卡片负责，两者不冲突。
 */
export default function Loading() {
  return (
    <div className="app">
      <div className="app-loading">
        <div className="spinner" />
        <span className="app-loading__text">正在准备界面…</span>
      </div>
    </div>
  );
}
