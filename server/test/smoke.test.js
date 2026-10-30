import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { startTestServer } from './helpers/test-server.js';

describe('服务冒烟', () => {
  it('健康检查返回 ok', async () => {
    const { baseUrl, close } = await startTestServer(createApp());

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const responseBody = await response.json();
      expect(responseBody.ok).toBe(true);
    } finally {
      await close();
    }
  });
});
