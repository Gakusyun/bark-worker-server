import { expect } from '@rstest/core';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';

expect.extend(jestDomMatchers);

// happy-dom's Response ignores a Headers instance in ResponseInit, which
// drops the headers Hono sets (e.g. Mcp-Session-Id). Normalize to a plain
// object before constructing the response.
const NativeResponse = globalThis.Response;
class ResponseWithPlainHeaders extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    if (init?.headers instanceof Headers) {
      init = { ...init, headers: Object.fromEntries(init.headers.entries()) };
    }
    super(body, init);
  }
}
globalThis.Response = ResponseWithPlainHeaders as typeof Response;
