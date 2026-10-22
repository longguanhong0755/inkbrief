/* inkbrief 对 image2strokes 的唯一依赖声明。升级引擎只改这个文件。
 *
 * 两种通道：
 *   pinned（生产默认）—— 锁定一个已验证的 commit，上游怎么改都不影响线上；
 *   dev / latest（本地默认）—— 优先同源兄弟目录里的最新代码，改完立刻能看到。
 *
 * 页面 URL 可用 ?engine=pinned|latest|dev 覆盖，例如：
 *   http://127.0.0.1:8743/inkbrief/?engine=latest
 */
self.INK_ENGINE = (() => {
  const repo = 'longguanhong0755/image2strokes';
  // 已验证可用、当前生产锁定的版本（v20，inkbrief 的笔触读数就是在这版上测的）
  const pin = '5cf7fea';
  return {
    api: 1,                 // 期望的 ISP_PIPELINE.api 契约版本
    entryVersion: 1,        // image2strokes/js/engine.js 的缓存号；契约文件变了才 +1
    repo,
    pin,
    pinUrl: `https://cdn.jsdelivr.net/gh/${repo}@${pin}/js/pipeline.js`,
    // 同源兄弟目录（本地两个项目并排 / GitHub Pages 同账号）和线上站点
    bases: [
      '../../image2strokes/js/',
      `https://longguanhong0755.github.io/image2strokes/js/`,
    ],
  };
})();
