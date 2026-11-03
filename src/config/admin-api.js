/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { getFetch } from '../fetch-utils.js';

export default class AdminApi {
  constructor({ token, base = 'https://admin.hlx.page', log }) {
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('AEM_ADMIN_TOKEN is required');
    }
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
      throw new Error('AEM_ADMIN_BASE must be an HTTP(S) origin without credentials');
    }
    this.base = url.origin;
    this.token = token;
    this.log = log;
    this.fetch = getFetch();
  }

  async request(method, resource, { body, type = 'json', allow404 = false } = {}) {
    const headers = { authorization: `token ${this.token}` };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = type === 'json' ? 'application/json' : type;
      payload = type === 'json' ? JSON.stringify(body) : body;
    }
    for (let attempt = 0; ; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await this.fetch(`${this.base}${resource}`, {
        method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      // Consume every response so retries do not leak keep-alive connections.
      // eslint-disable-next-line no-await-in-loop
      const text = await response.text();
      if ([429, 503].includes(response.status) && attempt < 3) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Math.min(30000, retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        this.log.warn(`Admin API ${response.status}; retrying ${method} ${resource}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      } else {
        if (response.status === 404 && allow404) {
          return { status: 404, data: null };
        }
        if (!response.ok) {
          // Server bodies and x-error headers can contain credential values.
          throw new Error(`Admin API ${method} ${resource} failed (${response.status})`);
        }
        let data = text;
        if (text && (response.headers.get('content-type') || '').includes('json')) {
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error(`Admin API ${method} ${resource}: invalid JSON response`);
          }
        }
        return { status: response.status, data };
      }
    }
  }

  get(resource, allow404 = false) {
    return this.request('GET', resource, { allow404 });
  }
}
