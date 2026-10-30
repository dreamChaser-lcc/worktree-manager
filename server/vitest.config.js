import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // 集成测试涉及真实 git 操作，串行执行避免临时仓库相互干扰
    fileParallelism: false,
    testTimeout: 30_000
  }
});
